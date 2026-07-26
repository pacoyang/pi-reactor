/**
 * Credential resolution.
 *
 * Values are inlined in `<dir>/credentials.json` (0600), keyed by sink or source
 * name. That is the ecosystem convention: pi's `~/.pi/agent/auth.json` and
 * pi-telegram's `telegram.json` do the same. The config JSON files hold no
 * credential values at all, which is why the config directory can be committed,
 * shared, or displayed in full by the extension's confirmation dialog.
 *
 * Resolution order (identical for sinks and providers, so there is one mental
 * model rather than two):
 *   1. $CREDENTIALS_DIRECTORY/<name>   systemd LoadCredential, opt-in
 *   2. credentials.json                the default path
 *   3. process.env[<NAME>]             the development and tmux path
 *   4. ~/.pi/agent/auth.json           providers only: the user likely ran `pi login`
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class CredentialError extends Error {
	override readonly name = "CredentialError";
}

/** Which source supplied the value, so `doctor` can report where it came from. */
export type CredentialSource = "systemd" | "credentials.json" | "env" | "pi-auth.json";

export interface ResolvedCredential {
	value: string;
	source: CredentialSource;
}

// ------------------------------------------------------------ credentials.json

type CredentialsFile = Record<string, Record<string, string>>;

export function readCredentialsFile(file: string): CredentialsFile {
	if (!existsSync(file)) return {};
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (cause) {
		throw new CredentialError(`cannot read credentials file: ${file}`, { cause });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new CredentialError(`credentials file is not valid JSON: ${file}`, { cause });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new CredentialError(`credentials file must be a JSON object: ${file}`);
	}
	return parsed as CredentialsFile;
}

function fromSystemd(name: string, env: NodeJS.ProcessEnv): string | undefined {
	const dir = env.CREDENTIALS_DIRECTORY;
	if (!dir) return undefined;
	const file = join(dir, name);
	if (!existsSync(file)) return undefined;
	try {
		// systemd-written credential files commonly carry a trailing newline.
		return readFileSync(file, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Environment variable name for a sink field: `REACTOR_<SINK>_<FIELD>`, upper
 * snake case, e.g. ("tg", "botToken") -> REACTOR_TG_BOT_TOKEN.
 */
export function sinkEnvName(sinkName: string, field: string): string {
	const sink = sinkName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	const suffix = field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
	return `REACTOR_${sink}_${suffix}`;
}

/**
 * Resolves one sink credential, e.g. ("tg", "botToken").
 *
 * `preloaded` lets a caller read credentials.json once and reuse it across many
 * lookups — the relay resolves a credential per delivery, and re-reading the
 * file each time would be pointless IO.
 */
export function resolveSinkCredential(
	sinkName: string,
	field: string,
	options: { credentialsFile: string; env?: NodeJS.ProcessEnv; preloaded?: CredentialsFile },
): ResolvedCredential | undefined {
	const env = options.env ?? process.env;

	const viaSystemd = fromSystemd(`${sinkName}_${field}`, env);
	if (viaSystemd) return { value: viaSystemd, source: "systemd" };

	const file = options.preloaded ?? readCredentialsFile(options.credentialsFile);
	const value = file[sinkName]?.[field];
	if (typeof value === "string" && value !== "") {
		return { value, source: "credentials.json" };
	}

	const viaEnv = env[sinkEnvName(sinkName, field)];
	if (viaEnv) return { value: viaEnv, source: "env" };

	return undefined;
}

// ------------------------------------------------------------ provider

/**
 * Provider variable names are DERIVED from pi's own table rather than hardcoded:
 * pi has around thirty providers with different variable names, so a hand-copied
 * table would drift. More importantly `ANTHROPIC_OAUTH_TOKEN` silently outranks
 * `ANTHROPIC_API_KEY`, so passing the host environment through would let a stray
 * variable change whose quota each job spends, with no error and no log.
 */
type FindEnvKeys = (provider: string, env: NodeJS.ProcessEnv) => string[] | undefined;

let cachedFindEnvKeys: FindEnvKeys | undefined;

/** Naming-convention fallback, OAuth first to match pi's own precedence. */
function conventionEnvKeys(provider: string, env: NodeJS.ProcessEnv): string[] {
	const up = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	return [`${up}_OAUTH_TOKEN`, `${up}_API_KEY`].filter((k) => env[k]);
}

/**
 * Measured against pi-ai 0.82.1 on 2026-07-26:
 *  - findEnvKeys("anthropic", {API_KEY, OAUTH_TOKEN}) returns
 *    ["...OAUTH_TOKEN", "...API_KEY"], confirming the silent-override risk;
 *  - an unknown provider (anything registered by an extension, such as sub2api)
 *    returns undefined rather than an empty array. So this must COMPOSE: use the
 *    upstream table when it knows the provider, otherwise fall back to the naming
 *    convention. Without that, extension-registered providers get misread as
 *    unconfigured.
 *  - the `./compat` subpath has an `import` condition but no `require` one, so it
 *    must be loaded with a dynamic import.
 */
export async function loadFindEnvKeys(): Promise<FindEnvKeys> {
	if (cachedFindEnvKeys) return cachedFindEnvKeys;
	let upstream: FindEnvKeys | undefined;
	try {
		const mod = (await import("@earendil-works/pi-ai/compat")) as { findEnvKeys?: FindEnvKeys };
		if (typeof mod.findEnvKeys === "function") upstream = mod.findEnvKeys;
	} catch {
		// Upstream unavailable: fall back to the convention entirely.
	}
	cachedFindEnvKeys = (provider, env) => {
		const found = upstream?.(provider, env);
		if (found && found.length > 0) return found;
		return conventionEnvKeys(provider, env);
	};
	return cachedFindEnvKeys;
}

export interface ProviderCredential {
	/** `{VAR: value}` injected into the job process; names come from the upstream table. */
	vars: Record<string, string>;
	source: CredentialSource;
}

interface PiAuthEntry {
	type?: string;
	key?: string;
	env?: Record<string, string>;
}

/**
 * Fourth tier: read the host's ~/.pi/agent/auth.json.
 * API-key entries only — an OAuth or subscription login expires and cannot be
 * refreshed unattended (the same call pi-dispatch makes). Always read host-side
 * and injected as env; the credential file is never mounted into the job.
 */
export function providerFromPiAuth(
	provider: string,
	envVarName: string,
	options: { agentDir?: string; env?: NodeJS.ProcessEnv } = {},
): ProviderCredential | undefined {
	const env = options.env ?? process.env;
	const agentDir = options.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const file = join(agentDir, "auth.json");
	if (!existsSync(file)) return undefined;
	let parsed: Record<string, PiAuthEntry>;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, PiAuthEntry>;
	} catch {
		return undefined;
	}
	const entry = parsed[provider];
	if (!entry || entry.type !== "api_key" || typeof entry.key !== "string" || entry.key === "") {
		return undefined;
	}
	const vars: Record<string, string> = { [envVarName]: entry.key };
	// An auth.json entry may carry extra env (sub2api ships a BASE_URL); keep it.
	for (const [k, v] of Object.entries(entry.env ?? {})) {
		if (typeof v === "string") vars[k] = v;
	}
	return { vars, source: "pi-auth.json" };
}

/**
 * Resolves a provider credential. Undefined means unconfigured, which preflight
 * turns into a refusal BEFORE spawn — rather than spawning and waiting for
 * `prompt` to answer "No API key found".
 */
export async function resolveProviderCredential(
	provider: string,
	options: { credentialsFile: string; env?: NodeJS.ProcessEnv; agentDir?: string },
): Promise<ProviderCredential | undefined> {
	const env = options.env ?? process.env;
	const findEnvKeys = await loadFindEnvKeys();
	const candidates = findEnvKeys(provider, env) ?? [];
	// Both key sources only NAME variables that are already set, so `candidates` is
	// empty in exactly the case tiers 1 and 4 exist for: the value lives outside the
	// environment. Falling back to the convention name is what makes those tiers
	// reachable at all — without it, systemd could only supply a credential that
	// tier 3 would already have found.
	const primary = candidates[0] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

	// 1. systemd credentials directory
	const viaSystemd = fromSystemd(`provider_${provider}`, env);
	if (viaSystemd) return { vars: { [primary]: viaSystemd }, source: "systemd" };

	// 2. the provider:<name> namespace inside credentials.json
	const file = readCredentialsFile(options.credentialsFile);
	const stored = file[`provider:${provider}`];
	if (stored) {
		const vars: Record<string, string> = {};
		for (const [k, v] of Object.entries(stored)) if (typeof v === "string") vars[k] = v;
		if (Object.keys(vars).length > 0) return { vars, source: "credentials.json" };
	}

	// 3. the daemon environment (findEnvKeys only names variables that are present)
	if (candidates.length > 0) {
		const vars: Record<string, string> = {};
		for (const name of candidates) {
			const v = env[name];
			if (v) vars[name] = v;
		}
		if (Object.keys(vars).length > 0) return { vars, source: "env" };
	}

	// 4. the host's pi login
	return providerFromPiAuth(provider, primary, {
		env,
		...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
	});
}

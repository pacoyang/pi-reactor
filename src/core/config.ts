/**
 * Config loading and fail-loud validation.
 *
 * Strict JSON, no comments — matching pi's settings.json and pi-dispatch's
 * triggers.json. These files hold preferences and references only, never
 * credential values: secrets live in credentials.json, which is why the
 * config directory can be committed, shared while asking for help, and displayed
 * in full by the extension's confirmation dialog.
 *
 * Validation policy:
 *   - failure at startup  -> refuse to start; better not running than running wrong
 *   - failure on reload   -> keep the previous config and carry on (see serve.ts)
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { Cron } from "croner";
import { parseDuration, parseDurationOr } from "./duration.ts";
import type { Paths } from "./paths.ts";

export class ConfigError extends Error {
	override readonly name = "ConfigError";
}

// Same charset as pi's skill names: lowercase kebab/underscore, no dots (blocks
// "..") and no slashes.
const NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export interface AgentProfile {
	name: string;
	cwd: string;
	provider: string;
	modelId: string;
	thinkingLevel?: string;
	/** Batch runs default to `-ne`; this is the explicit `-e` allowlist. A provider
	 *  registered by an extension must appear here or pi exits with "Unknown provider". */
	extensions: string[];
	env: Record<string, string>;
	maxDurationS: number;
}

export type NotifyWhen = "success" | "failure" | "always";

export interface NotifySpec {
	sink: string;
	when: NotifyWhen;
}

export interface SinkSpec {
	name: string;
	kind: "telegram" | "slack-webhook";
	/** telegram only */
	chatId?: number;
}

export interface CronTriggerSpec {
	kind: "cron";
	id: string;
	schedule: string;
	timezone?: string;
	misfirePolicy: "skip" | "fireOnce";
	run: RunSpec;
	notify?: NotifySpec;
	/**
	 * An agent asked for this one, through `schedule.add`.
	 *
	 * Recorded in the file rather than only in memory: whoever reads the config
	 * later should be able to tell what a human asked for from what an agent did,
	 * and the quota is counted from it.
	 */
	aiAuthored?: boolean;
}

export interface GithubTriggerSpec {
	kind: "github";
	id: string;
	event: string;
	action?: string[];
	any?: string[];
	run: RunSpec;
	notify?: NotifySpec;
}

export type TriggerSpec = CronTriggerSpec | GithubTriggerSpec;

export interface RunSpec {
	agent: string;
	task?: string;
	skill?: string;
	maxDurationS: number;
	requireCleanTree: boolean;
	retryable: boolean;
}

export interface Config {
	agents: Record<string, AgentProfile>;
	sinks: Record<string, SinkSpec>;
	triggers: TriggerSpec[];
}

/**
 * One public endpoint of the webhook process.
 *
 * Read by that process alone, at startup — it is the only configuration the
 * daemon does not own, because it describes the listener rather than the work,
 * and changing it means rebinding a port anyway.
 */
export interface WebhookEndpointSpec {
	name: string;
	path: string;
	/** Which signature family verifies this endpoint. Only `github` is implemented. */
	provider: string;
	/** Key in credentials.json holding the shared secret; defaults to the endpoint name. */
	credential: string;
	/**
	 * Sender ids whose deliveries are dropped before anything else.
	 * Your own bot is usually also a collaborator, so the loop guard has to run
	 * ahead of the authorization gate or a bot can authorise itself.
	 */
	ignoreSenders: string[];
	/**
	 * Who may trigger work. GitHub states this on the payload itself
	 * (`author_association`), so the gate costs no API call.
	 */
	allowAssociations: string[];
}

// ---------------------------------------------------------------- helpers

function readJson(file: string, what: string): unknown {
	if (!existsSync(file)) throw new ConfigError(`${what} not found: ${file}`);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (cause) {
		throw new ConfigError(`cannot read ${what}: ${file}`, { cause });
	}
	try {
		return JSON.parse(raw);
	} catch (cause) {
		const msg = cause instanceof Error ? cause.message : String(cause);
		throw new ConfigError(`${what} is not valid JSON (${file}): ${msg}`, { cause });
	}
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ConfigError(`${what} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new ConfigError(`${what} must be a non-empty string`);
	}
	return value;
}

// ---------------------------------------------------------------- agents

export function parseAgents(raw: unknown, file: string): Record<string, AgentProfile> {
	const root = asRecord(raw, `agents config (${file})`);
	const agents = asRecord(root.agents, `agents config (${file}): "agents"`);

	const out: Record<string, AgentProfile> = {};
	for (const [name, value] of Object.entries(agents)) {
		if (!NAME_RE.test(name)) {
			throw new ConfigError(`invalid agent name ${JSON.stringify(name)} (lowercase letters, digits, - and _; 1-64 chars)`);
		}
		const a = asRecord(value, `agent "${name}"`);
		const cwd = requireString(a.cwd, `agent "${name}": cwd`);
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
			throw new ConfigError(`agent "${name}": cwd does not exist or is not a directory: ${cwd}`);
		}
		const model = requireString(a.model, `agent "${name}": model`);
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) {
			throw new ConfigError(`agent "${name}": model must be "provider/model-id", got ${JSON.stringify(model)}`);
		}
		const extensions = a.extensions === undefined ? [] : a.extensions;
		if (!Array.isArray(extensions) || extensions.some((e) => typeof e !== "string")) {
			throw new ConfigError(`agent "${name}": extensions must be an array of paths`);
		}
		const envRaw = a.env === undefined ? {} : asRecord(a.env, `agent "${name}": env`);
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(envRaw)) {
			if (typeof v !== "string") throw new ConfigError(`agent "${name}": env.${k} must be a string`);
			env[k] = v;
		}

		out[name] = {
			name,
			cwd,
			provider: model.slice(0, slash),
			modelId: model.slice(slash + 1),
			...(typeof a.thinkingLevel === "string" ? { thinkingLevel: a.thinkingLevel } : {}),
			extensions: extensions as string[],
			env,
			maxDurationS: parseDurationOr(a.maxDuration as string | number | undefined, 1800),
		};
	}
	// Zero agents is valid. It used to be fatal, which was harmless while hand
	// editing was the only way to configure anything — but conversational config made the daemon the
	// thing you configure THROUGH, and refusing to start until a file already
	// exists means the conversational path can never take the first step. A daemon
	// with no agents simply has nothing to run; `doctor` says so.
	return out;
}

// ---------------------------------------------------------------- sinks

export function parseSinks(raw: unknown, file: string): Record<string, SinkSpec> {
	const root = asRecord(raw, `sinks config (${file})`);
	const sinks = asRecord(root.sinks, `sinks config (${file}): "sinks"`);

	const out: Record<string, SinkSpec> = {};
	for (const [name, value] of Object.entries(sinks)) {
		if (!NAME_RE.test(name)) throw new ConfigError(`invalid sink name ${JSON.stringify(name)}`);
		const s = asRecord(value, `sink "${name}"`);
		const kind = requireString(s.kind, `sink "${name}": kind`);
		if (kind !== "telegram" && kind !== "slack-webhook") {
			throw new ConfigError(`sink "${name}": unknown kind ${JSON.stringify(kind)} (telegram | slack-webhook)`);
		}
		if (kind === "telegram") {
			if (typeof s.chatId !== "number" || !Number.isInteger(s.chatId)) {
				throw new ConfigError(`sink "${name}": telegram requires an integer chatId`);
			}
			// No credential here: botToken lives under the same key in credentials.json
			out[name] = { name, kind, chatId: s.chatId };
		} else {
			out[name] = { name, kind };
		}
	}
	return out;
}

// ---------------------------------------------------------------- triggers

function parseRun(raw: unknown, where: string, agents: Record<string, AgentProfile>): RunSpec {
	const r = asRecord(raw, `${where}: run`);
	const agentName = requireString(r.agent, `${where}: run.agent`);
	const agent = agents[agentName];
	if (!agent) {
		throw new ConfigError(`${where}: run.agent "${agentName}" is not defined in agents.json`);
	}
	if (r.task === undefined && r.skill === undefined) {
		throw new ConfigError(`${where}: run needs a task or a skill`);
	}
	if (r.skill !== undefined && !NAME_RE.test(String(r.skill))) {
		throw new ConfigError(`${where}: run.skill ${JSON.stringify(r.skill)} is not a valid skill name`);
	}
	return {
		agent: agentName,
		...(typeof r.task === "string" ? { task: r.task } : {}),
		...(typeof r.skill === "string" ? { skill: r.skill } : {}),
		maxDurationS: parseDurationOr(r.maxDuration as string | number | undefined, agent.maxDurationS),
		requireCleanTree: r.requireCleanTree === true,
		retryable: r.retryable !== false,
	};
}

function parseNotify(raw: unknown, where: string, sinks: Record<string, SinkSpec>): NotifySpec | undefined {
	if (raw === undefined) return undefined;
	const n = asRecord(raw, `${where}: notify`);
	const sink = requireString(n.sink, `${where}: notify.sink`);
	if (!sinks[sink]) {
		throw new ConfigError(`${where}: notify.sink "${sink}" is not defined in sinks.json`);
	}
	const when = n.when === undefined ? "always" : String(n.when);
	if (when !== "success" && when !== "failure" && when !== "always") {
		throw new ConfigError(`${where}: notify.when must be success | failure | always, got ${JSON.stringify(when)}`);
	}
	return { sink, when };
}

export function parseTriggers(
	raw: unknown,
	file: string,
	agents: Record<string, AgentProfile>,
	sinks: Record<string, SinkSpec>,
): TriggerSpec[] {
	const root = asRecord(raw, `triggers config (${file})`);
	const list = root.triggers;
	if (!Array.isArray(list)) throw new ConfigError(`triggers config (${file}): "triggers" must be an array`);

	const seen = new Set<string>();
	const out: TriggerSpec[] = [];

	for (const [index, entry] of list.entries()) {
		const where = `triggers[${index}]`;
		const t = asRecord(entry, where);
		const on = asRecord(t.on, `${where}: on`);
		const type = requireString(on.type, `${where}: on.type`);
		const id = requireString(on.id, `${where}: on.id`);
		if (!NAME_RE.test(id)) throw new ConfigError(`${where}: on.id ${JSON.stringify(id)} is not a valid identifier`);
		if (seen.has(id)) throw new ConfigError(`${where}: duplicate trigger id ${JSON.stringify(id)}`);
		seen.add(id);

		const run = parseRun(t.run, where, agents);
		const notify = parseNotify(t.notify, where, sinks);

		if (type === "cron") {
			const schedule = requireString(on.schedule, `${where}: on.schedule`);
			const timezone = on.timezone === undefined ? undefined : requireString(on.timezone, `${where}: on.timezone`);
			// croner does NOT validate the timezone at construction: measured, a
			// `new Cron("0 9 * * *", {timezone:"Mars/Olympus"})` builds fine and only
			// `nextRun()` throws. So a real check has to compute one occurrence.
			// A null `nextRun()` means the expression can never fire (Feb 30 and
			// friends) — equally a silent config error, and one that would otherwise
			// sit quietly and never run.
			try {
				const probe = new Cron(schedule, { ...(timezone ? { timezone } : {}), paused: true });
				const next = probe.nextRun();
				probe.stop();
				if (next === null) {
					throw new ConfigError(`${where}: cron schedule ${JSON.stringify(schedule)} will never fire`);
				}
			} catch (cause) {
				if (cause instanceof ConfigError) throw cause;
				const msg = cause instanceof Error ? cause.message : String(cause);
				throw new ConfigError(
					`${where}: invalid cron schedule ${JSON.stringify(schedule)}${timezone ? ` (timezone ${timezone})` : ""}: ${msg}`,
					{ cause },
				);
			}
			const misfire = on.misfirePolicy === undefined ? "skip" : String(on.misfirePolicy);
			if (misfire !== "skip" && misfire !== "fireOnce") {
				throw new ConfigError(`${where}: on.misfirePolicy must be skip | fireOnce, got ${JSON.stringify(misfire)}`);
			}
			out.push({
				kind: "cron", id, schedule,
				...(timezone ? { timezone } : {}),
				misfirePolicy: misfire, run,
				...(notify ? { notify } : {}),
				...(t.aiAuthored === true ? { aiAuthored: true } : {}),
			});
		} else if (type === "github") {
			const event = requireString(on.event, `${where}: on.event`);
			out.push({
				kind: "github", id, event,
				...(Array.isArray(on.action) ? { action: on.action.map(String) } : {}),
				...(Array.isArray(on.any) ? { any: on.any.map(String) } : {}),
				run,
				...(notify ? { notify } : {}),
			});
		} else {
			throw new ConfigError(`${where}: unknown on.type ${JSON.stringify(type)} (cron | github)`);
		}
	}
	return out;
}

// ---------------------------------------------------------------- webhooks

/** Anyone who can push to the repo, in GitHub's own vocabulary. */
const DEFAULT_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

export function parseWebhooks(raw: unknown, file: string): Record<string, WebhookEndpointSpec> {
	const root = asRecord(raw, `webhooks config (${file})`);
	const endpoints = asRecord(root.endpoints, `webhooks config (${file}): "endpoints"`);

	const out: Record<string, WebhookEndpointSpec> = {};
	const seenPaths = new Map<string, string>();

	for (const [name, value] of Object.entries(endpoints)) {
		if (!NAME_RE.test(name)) throw new ConfigError(`invalid endpoint name ${JSON.stringify(name)}`);
		const e = asRecord(value, `endpoint "${name}"`);
		const path = requireString(e.path, `endpoint "${name}": path`);
		if (!path.startsWith("/")) throw new ConfigError(`endpoint "${name}": path must start with "/" (got ${JSON.stringify(path)})`);
		const clash = seenPaths.get(path);
		if (clash) throw new ConfigError(`endpoints "${clash}" and "${name}" both claim ${path}`);
		seenPaths.set(path, name);

		const provider = requireString(e.provider, `endpoint "${name}": provider`);
		const strings = (v: unknown, what: string, fallback: string[]): string[] => {
			if (v === undefined) return fallback;
			if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
				throw new ConfigError(`endpoint "${name}": ${what} must be an array of strings`);
			}
			return v as string[];
		};

		out[name] = {
			name,
			path,
			provider,
			credential: e.credential === undefined ? name : requireString(e.credential, `endpoint "${name}": credential`),
			ignoreSenders: strings(e.ignoreSenders, "ignoreSenders", []),
			allowAssociations: strings(e.allowAssociations, "allowAssociations", DEFAULT_ASSOCIATIONS),
		};
	}
	if (Object.keys(out).length === 0) throw new ConfigError(`webhooks config (${file}) defines no endpoints`);
	return out;
}

/** The webhook process's own configuration; absent means there is nothing to serve. */
export function loadWebhooks(paths: Paths): Record<string, WebhookEndpointSpec> {
	if (!existsSync(paths.webhooksFile)) return {};
	return parseWebhooks(readJson(paths.webhooksFile, "webhooks config"), paths.webhooksFile);
}

// ---------------------------------------------------------------- entry

/**
 * Loads every config file. Any invalid file throws `ConfigError`: there is no
 * partial load, because half a configuration is more dangerous than none — a
 * trigger pointing at a deleted agent fails silently in the middle of the night.
 *
 * Every file may be absent, and an empty configuration is a valid one: that is
 * the state a freshly installed daemon starts in, before the operator has said
 * what it should do. Present-but-invalid is still fatal.
 */
export function loadConfig(paths: Paths): Config {
	const agents = existsSync(paths.agentsFile)
		? parseAgents(readJson(paths.agentsFile, "agents config"), paths.agentsFile)
		: {};
	const sinks = existsSync(paths.sinksFile)
		? parseSinks(readJson(paths.sinksFile, "sinks config"), paths.sinksFile)
		: {};
	const triggers = existsSync(paths.triggersFile)
		? parseTriggers(readJson(paths.triggersFile, "triggers config"), paths.triggersFile, agents, sinks)
		: [];
	return { agents, sinks, triggers };
}

export { parseDuration };

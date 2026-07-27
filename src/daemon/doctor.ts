/**
 * Preflight diagnostics: every check the daemon would otherwise fail on, run up
 * front with a concrete fix for each.
 *
 * The point is that "why is nothing happening?" should be answerable in one
 * command rather than by reading logs. Runs entirely without a daemon, so it
 * works before the first `serve` and after a crash alike.
 */
import { existsSync, statSync, accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect } from "node:net";
import { resolveRpcEntry } from "./agent-runner.ts";
import type { Paths } from "../core/paths.ts";
import { loadConfig, loadWebhooks, ConfigError, type Config } from "../core/config.ts";
import { resolveProviderCredential, resolveSinkCredential } from "../core/credentials.ts";
import { openDb, userVersion } from "../core/db.ts";
import { MIGRATIONS } from "../core/migrations.ts";
import { buildJobEnv, findLeakedSecrets } from "./job-env.ts";
import { providerNames } from "../webhook/provider.ts";
import "../webhook/provider-github.ts";
import { readLock } from "./lock.ts";
import { errorSummary } from "./logger.ts";

export interface Check {
	ok: boolean;
	label: string;
	/** What to do about it. Only meaningful when ok is false. */
	fix?: string;
	/** Extra context worth showing even when the check passed. */
	note?: string;
}

/**
 * The pi releases this build is prepared to run against.
 *
 * A range rather than one version, because a package states compatibility and a
 * lockfile states what was installed — pinning an exact version here would claim
 * that every other release is broken, which is a claim nothing has tested.
 *
 * The upper bound is real, though: the RPC protocol carries no semver promise,
 * so compatibility is asserted only for the minor the contract tests cover.
 */
const SUPPORTED_PI_MINOR = "0.82";
const SUPPORTED_PI_RANGE = `${SUPPORTED_PI_MINOR}.x`;

export function piVersionSupported(version: string): boolean {
	// The full x.y.z shape is required: "0.82" is not a release, and matching it
	// would let a truncated or unread version pass as supported.
	return /^(\d+\.\d+)\.\d+/.exec(version)?.[1] === SUPPORTED_PI_MINOR;
}

export async function runDoctor(paths: Paths): Promise<Check[]> {
	const checks: Check[] = [];

	// ---- environment ----------------------------------------------------
	const [major, minor] = process.versions.node.split(".").map(Number);
	const nodeOk = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 19);
	checks.push({
		ok: nodeOk,
		label: `Node >= 22.19 (have ${process.versions.node})`,
		fix: "upgrade Node: type stripping without a build step needs 22.19 or newer",
	});

	checks.push(pinnedPiCheck());

	// ---- directory ------------------------------------------------------
	checks.push({
		ok: existsSync(paths.root) && isWritable(paths.root),
		label: `Directory writable (${paths.root})`,
		fix: "create it or fix its permissions; PI_REACTOR_DIR overrides the location",
	});

	// The database is the second most common reason nothing happens (after config),
	// and opening it also runs the migrations, so this reports schema drift too.
	checks.push(databaseCheck(paths));

	const lock = readLock(paths.pidFile);
	const daemonAlive = lock !== null && isAlive(lock.pid);
	if (lock) {
		checks.push({
			ok: true,
			label: daemonAlive ? `Daemon running (pid ${lock.pid}, since ${lock.startedAt})` : "No daemon running",
			...(daemonAlive ? {} : { note: `stale lock from pid ${lock.pid} will be taken over at next start` }),
		});
	} else {
		checks.push({ ok: true, label: "No daemon running" });
	}

	// A live daemon whose socket does not answer is the exact shape of "the CLI
	// says nothing is wrong but nothing responds", so it is worth its own line.
	checks.push(await socketCheck(paths, daemonAlive));

	// ---- config ---------------------------------------------------------
	let config: Config | undefined;
	try {
		config = loadConfig(paths);
		checks.push({
			ok: true,
			label: `Config valid (${Object.keys(config.agents).length} agents, ` +
				`${Object.keys(config.sinks).length} sinks, ${config.triggers.length} triggers)`,
		});
	} catch (err) {
		checks.push({
			ok: false,
			label: "Config valid",
			fix: err instanceof ConfigError ? err.message : errorSummary(err),
		});
		// Everything below needs a config; stop here rather than cascade.
		return checks;
	}

	// ---- agents ---------------------------------------------------------
	if (Object.keys(config.agents).length === 0) {
		checks.push({
			ok: true,
			label: "No agents configured yet",
			note: "the daemon runs, but has nothing to run; add one with /reactor in pi, or `pi-reactor agent add`",
		});
	}
	for (const agent of Object.values(config.agents)) {
		const cwdOk = existsSync(agent.cwd) && statSync(agent.cwd).isDirectory();
		checks.push({
			ok: cwdOk,
			label: `agent "${agent.name}": cwd exists (${agent.cwd})`,
			fix: `create ${agent.cwd} or point the agent somewhere else`,
		});

		const credential = await resolveProviderCredential(agent.provider, {
			credentialsFile: paths.credentialsFile,
		}).catch(() => undefined);
		checks.push({
			ok: credential !== undefined,
			label: `agent "${agent.name}": provider "${agent.provider}" credential`,
			...(credential ? { note: `from ${credential.source}` } : {}),
			fix:
				`add it to ${paths.credentialsFile} under "provider:${agent.provider}", ` +
				`or set the provider's API key in the daemon environment, or run \`pi login\``,
		});

		// A provider registered by an extension needs that extension allowlisted,
		// because batch runs always pass -ne.
		if (agent.extensions.length > 0) {
			const missing = agent.extensions.filter((e) => !existsSync(e));
			checks.push({
				ok: missing.length === 0,
				label: `agent "${agent.name}": ${agent.extensions.length} allowlisted extension(s) exist`,
				fix: `missing: ${missing.join(", ")}`,
			});
		}

		// Turns "sink credentials never reach the agent" from a comment into a fact
		// about this configuration: the allowlist blocks the host environment, but
		// an agent's own `env` block could still hand one over by hand.
		const leaked = findLeakedSecrets(
			buildJobEnv({ agent, jobId: 0, socketPath: paths.sock, providerVars: credential?.vars ?? {} }),
		);
		if (leaked.length > 0) {
			checks.push({
				ok: false,
				label: `agent "${agent.name}": job environment carries no sink credentials`,
				fix: `remove ${leaked.join(", ")} from this agent's env: notifications go through the socket, never a token in the job`,
			});
		}
	}

	// ---- sinks ----------------------------------------------------------
	for (const sink of Object.values(config.sinks)) {
		if (sink.kind === "telegram") {
			const token = resolveSinkCredential(sink.name, "botToken", { credentialsFile: paths.credentialsFile });
			checks.push({
				ok: token !== undefined,
				label: `sink "${sink.name}": telegram botToken`,
				...(token ? { note: `from ${token.source}` } : {}),
				fix: `add {"${sink.name}": {"botToken": "..."}} to ${paths.credentialsFile} (mode 0600)`,
			});
		} else {
			const url = resolveSinkCredential(sink.name, "webhookUrl", { credentialsFile: paths.credentialsFile });
			checks.push({
				ok: url !== undefined,
				label: `sink "${sink.name}": slack webhookUrl`,
				...(url ? { note: `from ${url.source}` } : {}),
				fix: `pi-reactor secret set ${sink.name} webhookUrl  (the incoming-webhook URL is itself the credential)`,
			});
		}
	}

	// ---- webhook endpoints ----------------------------------------------
	// Checked here rather than in the webhook process because a missing secret
	// should be findable before you expose a port, not after.
	try {
		const endpoints = loadWebhooks(paths);
		for (const endpoint of Object.values(endpoints)) {
			const known = providerNames().includes(endpoint.provider);
			checks.push({
				ok: known,
				label: `endpoint "${endpoint.name}": provider "${endpoint.provider}"`,
				fix: `unknown provider; available: ${providerNames().join(", ")}`,
			});
			const secret = resolveSinkCredential(endpoint.credential, "webhookSecret", {
				credentialsFile: paths.credentialsFile,
			});
			checks.push({
				ok: secret !== undefined,
				label: `endpoint "${endpoint.name}": webhookSecret`,
				...(secret ? { note: `from ${secret.source}` } : {}),
				fix: `pi-reactor secret set ${endpoint.credential} webhookSecret  (paste the same value into GitHub's hook)`,
			});
		}
		const githubTriggers = config.triggers.filter((t) => t.kind === "github").length;
		if (githubTriggers > 0 && Object.keys(endpoints).length === 0) {
			checks.push({
				ok: false,
				label: `${githubTriggers} github trigger(s) but no webhook endpoint`,
				fix: `nothing can deliver to them; add an endpoint to ${paths.webhooksFile}`,
			});
		}
	} catch (err) {
		checks.push({ ok: false, label: "Webhook config valid", fix: errorSummary(err) });
	}

	// ---- triggers -------------------------------------------------------
	// Config validation already rejected bad cron expressions and unknown
	// references, so reaching here means the wiring is sound.
	const cronCount = config.triggers.filter((t) => t.kind === "cron").length;
	if (cronCount > 0) {
		checks.push({ ok: true, label: `${cronCount} cron trigger(s) configured` });
	}

	return checks;
}

/**
 * Reads the resolved pi version.
 *
 * Cannot `require("@earendil-works/pi-coding-agent/package.json")`: that subpath
 * is not in the package's exports map (the third time this bit us, after
 * `/compat` and `/rpc-entry`). Instead resolve the one subpath that IS exported
 * and walk up from dist/ to the package root.
 */
function pinnedPiCheck(): Check {
	try {
		const packageRoot = dirname(dirname(resolveRpcEntry()));
		const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
		const version = pkg.version ?? "unknown";
		return {
			ok: piVersionSupported(version),
			label: `pi ${version} is supported (${SUPPORTED_PI_RANGE})`,
			fix:
				`the RPC protocol carries no semver promise across minors, and nothing has tested this one. ` +
				`Install a supported release, or run \`npm run test:contract\` against it and widen the range if it passes.`,
		};
	} catch (err) {
		return {
			ok: false,
			label: "pi coding agent resolvable",
			fix: `install it: ${errorSummary(err)}`,
		};
	}
}

/**
 * Opens the database, which also applies any pending migration, and reports the
 * resulting schema version. A permission problem, a corrupt file or a migration
 * that cannot apply all surface here rather than as a failed `serve`.
 */
function databaseCheck(paths: Paths): Check {
	try {
		const db = openDb(paths.db);
		const version = userVersion(db);
		db.close();
		return {
			ok: version === MIGRATIONS.length,
			label: `Database usable (${paths.db})`,
			note: `schema v${version}`,
			fix: `schema is v${version} but this build expects v${MIGRATIONS.length}; a newer pi-reactor may have migrated it`,
		};
	} catch (err) {
		return {
			ok: false,
			label: "Database usable",
			fix: `cannot open ${paths.db}: ${errorSummary(err)}`,
		};
	}
}

/**
 * Connects to the control socket and issues a real `status` call.
 *
 * Only meaningful while a daemon holds the lock: with none running, the absence
 * of a socket is the correct state rather than a fault.
 */
async function socketCheck(paths: Paths, daemonAlive: boolean): Promise<Check> {
	if (!daemonAlive) {
		return { ok: true, label: "Control socket", note: "not listening (no daemon running)" };
	}
	try {
		await new Promise<void>((resolve, reject) => {
			const socket = connect(paths.sock);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("no reply within 3s"));
			}, 3000);
			timer.unref();
			const done = (err?: Error): void => {
				clearTimeout(timer);
				socket.destroy();
				if (err) reject(err);
				else resolve();
			};
			socket.on("error", done);
			socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status" })}\n`));
			socket.on("data", () => done());
		});
		return { ok: true, label: `Control socket answering (${paths.sock})` };
	} catch (err) {
		return {
			ok: false,
			label: "Control socket answering",
			fix: `the daemon holds the lock but ${paths.sock} did not respond (${errorSummary(err)}); check its logs, then restart it`,
		};
	}
}

function isWritable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Renders checks for a terminal; returns true when everything passed. */
export function formatChecks(checks: Check[]): { text: string; ok: boolean } {
	const lines: string[] = [];
	let ok = true;
	for (const check of checks) {
		if (!check.ok) ok = false;
		const mark = check.ok ? "✓" : "✗";
		lines.push(`${mark} ${check.label}${check.note ? `  (${check.note})` : ""}`);
		if (!check.ok && check.fix) lines.push(`    → ${check.fix}`);
	}
	return { text: `${lines.join("\n")}\n`, ok };
}


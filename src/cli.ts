#!/usr/bin/env node
/**
 * Single binary, subcommand dispatch.
 *
 * `serve` runs the daemon; every other subcommand is a thin JSON-RPC client over
 * the unix socket. That split is what lets the same methods back both the CLI and
 * the pi extension without either drifting.
 */
import { resolvePaths, type Paths } from "./core/paths.ts";
import { callDaemon } from "./core/rpc-client.ts";
import type { StatusResult } from "./core/rpc-types.ts";
import { formatDuration, parseDuration } from "./core/duration.ts";

const USAGE = `pi-reactor — self-hosted agent event loop

  serve [options]              Run the daemon (singleton per directory)
  webhook [--port 8787]        Run the public webhook listener (separate process)
  service [--systemd|--launchd] [--user|--system] [serve options]
                               Print a service definition for this install;
                               any serve option given is written onto the unit
  emit --agent <name> [...]    Enqueue a job
  status                       Queue, spend and agent overview
  runs [--dead] [--limit N]    Recent run history
  resume <run-id> [--print]    Continue that run's conversation in your own pi
  rerun <run-id>               Queue the same work again as a new job
  notify --sink <s> <body>     Queue an outbound message
  pause | resume               Durable queue switch
  reload                       Re-read config from disk
  doctor                       Preflight: versions, paths, credentials, config
  schedule ls                  Cron watermarks and breaker state
  schedule resume <id>         Clear a tripped breaker and re-arm
  schedule add|rm <id>         Agent self-scheduling (inside a job; quota-limited)

  Config (same daemon methods the /reactor extension uses; takes effect at once):
    agent   ls | add <name> --cwd <dir> --model <p/m> [--extension <path>…] | rm <name>
    sink    ls | add <name> --kind telegram --chat-id <n> | rm <name>
    trigger ls | add <id> --schedule <cron> --agent <a> --task <t> | rm <id>
    secret  set <name> <field>   Read a credential from stdin (never echoed)
    Add --dry-run to any write to see the before/after without applying it.

  serve options:
    --concurrency <2>          Jobs running at once (one per agent regardless)
    --daily-token-cap <N>      Refuse new jobs past N tokens today; unset = no cap
    --retention-days <30>      Age at which rows and session files are reclaimed
    --shutdown-grace <60s>     Drain budget on SIGTERM; keep below TimeoutStopSec

  emit options:
    --agent <name>             Required
    --task <text>              Task for this run
    --skill <name>             Skill to run instead of a task
    --id <string>              Event id, for idempotent re-emits
    --notify <sink>            Notify on completion
    --when <success|failure|always>
    --max-duration <30m>
    --require-clean-tree       Refuse if the agent's working tree is dirty

  Global:
    PI_REACTOR_DIR             Override ~/.pi-reactor
`;

/** The `serve` options a unit may carry. Kept beside the flags serve itself reads. */
const SERVE_OPTIONS = ["concurrency", "daily-token-cap", "retention-days", "shutdown-grace"] as const;

interface Args {
	command: string;
	flags: Record<string, string | boolean>;
	/** Every value a flag was given, in order. A flag pi itself allows more than
	 *  once — `-e` above all — cannot be carried by a last-one-wins map. */
	repeated: Record<string, string[]>;
	positional: string[];
}

function parseArgs(argv: string[]): Args {
	const [command = "", ...rest] = argv;
	const flags: Record<string, string | boolean> = {};
	const repeated: Record<string, string[]> = {};
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i] as string;
		if (token.startsWith("--")) {
			const key = token.slice(2);
			const next = rest[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				(repeated[key] ??= []).push(next);
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(token);
		}
	}
	return { command, flags, repeated, positional };
}

/** Every subcommand but `serve` is a thin client over the socket. */
function rpcCall(paths: Paths, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
	return callDaemon({ socketPath: paths.sock }, method, params);
}

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * `agent|sink|trigger  ls|add|rm`.
 *
 * A thin shell over the same JSON-RPC methods the extension calls, so the two
 * cannot drift. The flags cover the common shape; anything richer is
 * either a conversation with `/reactor` or an edit to the JSON, and both end up
 * validated by the same daemon.
 */
async function configCommand(paths: Paths, args: Args): Promise<void> {
	const kind = args.command as "agent" | "sink" | "trigger";
	const sub = args.positional[0] ?? "ls";
	const dryRun = args.flags["dry-run"] === true;

	if (sub === "ls") {
		const key = `${kind}s` as "agents" | "sinks" | "triggers";
		const result = (await rpcCall(paths, `${kind}.ls`)) as Record<string, unknown[]>;
		const rows = result[key] ?? [];
		if (rows.length === 0) {
			process.stdout.write(`no ${key} configured\n`);
			return;
		}
		process.stdout.write(`${JSON.stringify(rows, null, "\t")}\n`);
		return;
	}

	const name = args.positional[1];
	if (!name) fail(`${kind} ${sub} requires a name`);

	if (sub === "rm") {
		const result = (await rpcCall(paths, `${kind}.delete`, { ...(kind === "trigger" ? { id: name } : { name }), dryRun })) as ConfigChange;
		reportConfigChange(result, `${kind} ${name} removed`);
		return;
	}

	if (sub !== "add") fail(`unknown ${kind} subcommand "${sub}" (ls | add | rm)`);

	const flag = (key: string): string | undefined => (typeof args.flags[key] === "string" ? args.flags[key] : undefined);
	let params: Record<string, unknown>;

	if (kind === "agent") {
		const cwd = flag("cwd");
		const model = flag("model");
		if (!cwd || !model) fail("agent add requires --cwd <dir> and --model <provider/model-id>");
		// Batch runs are spawned with `-ne`, so a provider that an extension
		// registers is invisible unless that extension is named here. Without this
		// the agent is configurable but unrunnable, and the failure arrives at the
		// first scheduled run rather than at the point of configuration.
		const extensions = args.repeated["extension"] ?? [];
		params = {
			name,
			agent: {
				cwd,
				model,
				...(extensions.length > 0 ? { extensions } : {}),
				...(flag("max-duration") ? { maxDuration: flag("max-duration") } : {}),
				...(flag("thinking-level") ? { thinkingLevel: flag("thinking-level") } : {}),
			},
		};
	} else if (kind === "sink") {
		const chatId = flag("chat-id");
		if (!chatId) fail("sink add requires --chat-id <n> (telegram)");
		params = { name, sink: { kind: flag("kind") ?? "telegram", chatId: Number(chatId) } };
	} else {
		const schedule = flag("schedule");
		const agent = flag("agent");
		if (!schedule || !agent) fail("trigger add requires --schedule <cron> and --agent <name>");
		if (!flag("task") && !flag("skill")) fail("trigger add requires --task <text> or --skill <name>");
		params = {
			trigger: {
				on: {
					type: "cron",
					id: name,
					schedule,
					...(flag("timezone") ? { timezone: flag("timezone") } : {}),
					...(flag("misfire-policy") ? { misfirePolicy: flag("misfire-policy") } : {}),
				},
				run: {
					agent,
					...(flag("task") ? { task: flag("task") } : {}),
					...(flag("skill") ? { skill: flag("skill") } : {}),
					...(flag("max-duration") ? { maxDuration: flag("max-duration") } : {}),
				},
				...(flag("notify") ? { notify: { sink: flag("notify"), when: flag("when") ?? "always" } } : {}),
			},
		};
	}

	const result = (await rpcCall(paths, `${kind}.add`, { ...params, dryRun })) as ConfigChange;
	reportConfigChange(result, `${kind} ${name} added`);
}

interface ConfigChange {
	file: string;
	before: string;
	after: string;
	changed: boolean;
	applied: boolean;
}

function reportConfigChange(result: ConfigChange, done: string): void {
	if (!result.changed) {
		process.stdout.write("no change\n");
		return;
	}
	if (!result.applied) {
		// The dry run's whole point: see the validated result before committing.
		process.stdout.write(`# would write ${result.file}\n${result.after}`);
		return;
	}
	process.stdout.write(`${done} (${result.file})\n`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const paths = resolvePaths();

	switch (args.command) {
		case "serve": {
			const { serve } = await import("./daemon/serve.ts");
			// The budget gate has no home in the config JSONs — those hold
			// references and preferences, and a spend ceiling is an operational
			// property of THIS deployment. Flags on the unit file are where it
			// belongs, and without them the gate had no way to be switched on at all.
			const number = (key: string): number | undefined => {
				const raw = args.flags[key];
				if (typeof raw !== "string") return undefined;
				const value = Number(raw);
				if (!Number.isFinite(value) || value <= 0) fail(`--${key} must be a positive number, got ${raw}`);
				return value;
			};
			const concurrency = number("concurrency");
			const dailyTokenCap = number("daily-token-cap");
			const retentionDays = number("retention-days");
			const shutdownGrace =
				typeof args.flags["shutdown-grace"] === "string"
					? parseDuration(args.flags["shutdown-grace"]) * 1000
					: undefined;

			await serve({
				paths,
				...(concurrency !== undefined ? { concurrency } : {}),
				...(dailyTokenCap !== undefined ? { dailyTokenCap } : {}),
				...(retentionDays !== undefined ? { retentionDays } : {}),
				...(shutdownGrace !== undefined ? { shutdownGraceMs: shutdownGrace } : {}),
			});
			// serve() resolves once listening; the process stays alive on its handles.
			return;
		}

		case "service": {
			// Printed, not installed: nothing lands in a system location without you
			// asking, and you can read it first. The shape `podman generate systemd`
			// and `gh completion` both use.
			const { defaultServiceKind, defaultServiceScope, serviceUnitInput, renderServiceUnit, serviceInstallHint } =
				await import("./core/service-unit.ts");
			const kind = args.flags.launchd === true ? "launchd" : args.flags.systemd === true ? "systemd" : defaultServiceKind();
			// Scope is a separate axis from the init system, and both have it: systemd
			// --user units and launchd LaunchAgents belong to a login session; system
			// units and LaunchDaemons do not. Defaults from whether this is root,
			// because a user unit on a root-only box installs fine and never starts.
			const scope = args.flags.system === true ? "system" : args.flags.user === true ? "user" : defaultServiceScope();
			// Any `serve` option given here is written onto the unit, because that is
			// the only place it can live: the spend ceiling is not a config-file
			// preference, and a service-managed daemon is started by the unit and
			// nothing else. Validated here rather than at first boot — a unit that
			// installs cleanly and then refuses to start is the failure this whole
			// generated-unit approach exists to avoid.
			const serveArgs: string[] = [];
			for (const key of SERVE_OPTIONS) {
				const raw = args.flags[key];
				if (raw === undefined) continue;
				if (typeof raw !== "string") fail(`--${key} needs a value`);
				if (key === "shutdown-grace") parseDuration(raw);
				else if (!Number.isFinite(Number(raw)) || Number(raw) <= 0) fail(`--${key} must be a positive number, got ${raw}`);
				serveArgs.push(`--${key}`, raw);
			}
			process.stdout.write(renderServiceUnit(kind, scope, { ...serviceUnitInput(paths), serveArgs }));
			// The how-to goes to stderr so a redirect keeps the unit file clean.
			process.stderr.write(serviceInstallHint(kind, scope));
			return;
		}

		case "webhook": {
			// Its own process, and its own lifetime: it binds a public port, so it
			// should be restartable and killable without touching the queue.
			const { serveWebhooks } = await import("./webhook/serve.ts");
			const port = typeof args.flags.port === "string" ? Number(args.flags.port) : undefined;
			const host = typeof args.flags.host === "string" ? args.flags.host : undefined;
			// Default 127.0.0.1: the public entrance is a tunnel or a reverse proxy,
			// never this process binding 0.0.0.0 by accident.
			const running = await serveWebhooks({
				paths,
				...(port !== undefined ? { port } : {}),
				...(host !== undefined ? { host } : {}),
			});
			for (const signal of ["SIGTERM", "SIGINT"] as const) {
				process.on(signal, () => {
					void running.stop().then(() => process.exit(0));
				});
			}
			return;
		}

		case "emit": {
			const agent = args.flags.agent;
			if (typeof agent !== "string") fail("emit requires --agent <name>");
			const route: Record<string, unknown> = { agent };
			if (typeof args.flags.task === "string") route.task = args.flags.task;
			if (typeof args.flags.skill === "string") route.skill = args.flags.skill;
			if (typeof args.flags["max-duration"] === "string") route.maxDuration = args.flags["max-duration"];
			if (args.flags["require-clean-tree"] === true) route.requireCleanTree = true;

			const params: Record<string, unknown> = { lane: "batch", route };
			if (typeof args.flags.id === "string") params.id = args.flags.id;
			if (typeof args.flags.notify === "string") {
				params.notify = {
					sink: args.flags.notify,
					...(typeof args.flags.when === "string" ? { when: args.flags.when } : {}),
				};
			}

			const result = (await rpcCall(paths, "emit", params)) as { seq: number; jobId: number | null; duplicate: boolean };
			if (result.duplicate) {
				process.stdout.write(`duplicate (seq ${result.seq}) — already enqueued, nothing to do\n`);
			} else {
				process.stdout.write(`queued job ${result.jobId} (seq ${result.seq})\n`);
			}
			return;
		}

		case "status": {
			const s = (await rpcCall(paths, "status")) as StatusResult;
			const uptime = formatDuration(Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000));
			const cap = s.today.cap === null ? "no cap" : `cap ${s.today.cap}`;
			// The dead count earns its line: it is the only number that says a
			// notification you were promised is never arriving.
			const dead = s.outbox.dead > 0 ? ` · ${s.outbox.dead} DEAD` : "";
			process.stdout.write(
				`daemon  running (pid ${s.pid}, up ${uptime})${s.paused ? "  [PAUSED]" : ""}\n` +
				`queue   ${s.queue.pending} pending · ${s.queue.running} running\n` +
				`outbox  ${s.outbox.pending} pending${dead}\n` +
				`today   ${s.today.runs} runs · ${s.today.totalTokens} tokens (${cap})\n` +
				`agents  ${s.agents.join(", ") || "(none)"}\n`,
			);
			return;
		}

		case "runs": {
			const params: Record<string, unknown> = {};
			if (args.flags.dead === true) params.dead = true;
			if (typeof args.flags.limit === "string") params.limit = Number(args.flags.limit);
			const { runs } = (await rpcCall(paths, "runs", params)) as {
				runs: Array<{ id: number; agent: string; outcome: string | null; reason: string | null; totalTokens: number | null; startedAt: string; errorSummary: string | null }>;
			};
			if (runs.length === 0) {
				process.stdout.write("no runs yet\n");
				return;
			}
			for (const r of runs) {
				const mark = r.outcome === "succeeded" ? "ok  " : r.outcome === "interrupted" ? "intr" : "FAIL";
				const reason = r.reason ? ` ${r.reason}` : "";
				const tokens = r.totalTokens ? ` ${r.totalTokens}t` : "";
				process.stdout.write(`${mark} #${r.id} ${r.agent}${reason}${tokens}  ${r.startedAt}\n`);
				if (r.errorSummary) process.stdout.write(`     ${r.errorSummary}\n`);
			}
			return;
		}

		case "resume": {
			// Closes the loop a notification opens. The message says "run 42";
			// this hands run 42's transcript to your own interactive pi, in the
			// directory the job ran in, so the follow-up question lands in the same
			// context the answer came from.
			const run = Number(args.positional[0]);
			if (!Number.isInteger(run)) fail("usage: pi-reactor resume <run-id>   (see `pi-reactor runs`)");

			const session = (await rpcCall(paths, "run.session", { run })) as {
				runId: number; agent: string; outcome: string | null; startedAt: string;
				sessionFile: string | null; cwd: string | null; exists: boolean;
			};

			if (!session.sessionFile) {
				fail(`run ${run} has no transcript: it died before pi opened a session (outcome: ${session.outcome ?? "?"})`);
			}
			if (!session.exists) {
				// Sessions age out with everything else. Saying so beats letting
				// pi report a missing file the operator did not choose.
				fail(
					`run ${run}'s transcript is gone: ${session.sessionFile}\n` +
						`Sessions are reclaimed with the rest of the history (default 30 days).`,
				);
			}

			if (args.flags.print === true) {
				process.stdout.write(`${session.sessionFile}\n`);
				return;
			}

			const { spawn } = await import("node:child_process");
			const child = spawn("pi", ["--session", session.sessionFile], {
				stdio: "inherit",
				// The same working tree the job had. Resuming from elsewhere would give
				// the agent its old conversation over a different set of files.
				...(session.cwd ? { cwd: session.cwd } : {}),
			});
			child.on("error", (err: NodeJS.ErrnoException) => {
				fail(
					err.code === "ENOENT"
						? `pi is not on PATH. Open it yourself:\n  cd ${session.cwd ?? "."} && pi --session ${session.sessionFile}`
						: err.message,
				);
			});
			child.on("exit", (code) => process.exit(code ?? 0));
			return;
		}

		case "rerun": {
			// Addressed by run id, because that is what `runs` prints. `--job` is
			// there for the row a run points at, which outlives nothing but is what
			// the RPC actually keys on.
			const run = Number(args.positional[0]);
			const job = typeof args.flags.job === "string" ? Number(args.flags.job) : undefined;
			if (job === undefined && !Number.isInteger(run)) fail("rerun requires a run id (see `pi-reactor runs`)");
			const result = (await rpcCall(
				paths,
				"rerun",
				job !== undefined ? { job } : { run },
			)) as { jobId: number | null };
			process.stdout.write(`queued job ${result.jobId}\n`);
			return;
		}

		case "notify": {
			const sink = args.flags.sink;
			if (typeof sink !== "string") fail("notify requires --sink <name>");
			const body = args.positional.join(" ");
			if (!body) fail("notify requires a message body");
			const { outboxId } = (await rpcCall(paths, "notify", { sink, body })) as { outboxId: number };
			process.stdout.write(`queued notification ${outboxId}\n`);
			return;
		}

		case "doctor": {
			const { runDoctor, formatChecks } = await import("./daemon/doctor.ts");
			const { text, ok } = formatChecks(await runDoctor(paths));
			process.stdout.write(text);
			if (!ok) process.exit(1);
			return;
		}

		case "schedule": {
			const sub = args.positional[0];
			if (sub === "ls" || sub === undefined) {
				const { schedules } = (await rpcCall(paths, "schedule.ls")) as {
					schedules: Array<{ id: string; lastFiredAt: string | null; consecutiveFailures: number; trippedAt: string | null; configured: boolean }>;
				};
				if (schedules.length === 0) {
					process.stdout.write("no schedules yet\n");
					return;
				}
				for (const s of schedules) {
					const state = s.trippedAt ? "TRIPPED" : s.configured ? "armed  " : "orphan ";
					const fails = s.consecutiveFailures > 0 ? ` ${s.consecutiveFailures} consecutive failures` : "";
					process.stdout.write(`${state} ${s.id}  last fired ${s.lastFiredAt ?? "never"}${fails}\n`);
				}
				return;
			}
			if (sub === "resume") {
				const id = args.positional[1];
				if (!id) fail("schedule resume requires a trigger id");
				await rpcCall(paths, "schedule.resume", { id });
				process.stdout.write(`schedule ${id} resumed\n`);
				return;
			}

			// `add` and `rm` are the agent-facing half: they need the per-job
			// token, which only a running job has, so an operator reaching for them
			// by hand gets told to use `trigger` instead.
			if (sub === "add" || sub === "rm") {
				const token = process.env.PI_REACTOR_TOKEN;
				if (!token) {
					fail(
						`schedule ${sub} is for agents running inside a job (it needs PI_REACTOR_TOKEN).\n` +
							`As the operator, use: pi-reactor trigger ${sub === "add" ? "add" : "rm"} …`,
					);
				}
				const id = args.positional[1];
				if (!id) fail(`schedule ${sub} requires an id`);
				if (sub === "rm") {
					await rpcCall(paths, "schedule.rm", { token, id });
					process.stdout.write(`schedule ${id} removed\n`);
					return;
				}
				const flag = (key: string): string | undefined =>
					typeof args.flags[key] === "string" ? args.flags[key] : undefined;
				const schedule = flag("schedule");
				const agent = flag("agent");
				if (!schedule || !agent) fail("schedule add requires --schedule <cron> and --agent <name>");
				await rpcCall(paths, "schedule.add", {
					token,
					id,
					schedule,
					agent,
					...(flag("task") ? { task: flag("task") } : {}),
					...(flag("skill") ? { skill: flag("skill") } : {}),
					...(flag("timezone") ? { timezone: flag("timezone") } : {}),
					...(flag("notify") ? { notify: flag("notify") } : {}),
				});
				process.stdout.write(`schedule ${id} added\n`);
				return;
			}

			fail(`unknown schedule subcommand "${sub}" (ls | resume | add | rm)`);
			return;
		}

		case "agent":
		case "sink":
		case "trigger":
			await configCommand(paths, args);
			return;

		case "secret": {
			// Read from stdin, never from argv: a token on a command line lands in
			// shell history and in every `ps` on the machine.
			const [sub, name, field] = args.positional;
			if (sub !== "set" || !name || !field) fail("usage: pi-reactor secret set <name> <field>  (value on stdin)");
			const value = (await readStdin()).trim();
			if (!value) fail("no value on stdin");
			await rpcCall(paths, "credential.set", { name, field, value });
			process.stdout.write(`stored ${name}.${field}\n`);
			return;
		}

		case "pause":
		case "resume": {
			const { paused } = (await rpcCall(paths, args.command)) as { paused: boolean };
			process.stdout.write(paused ? "queue paused\n" : "queue resumed\n");
			return;
		}

		case "reload": {
			const r = (await rpcCall(paths, "reload")) as { agents: number; triggers: number };
			process.stdout.write(`config reloaded: ${r.agents} agents, ${r.triggers} triggers\n`);
			return;
		}

		case "":
		case "help":
		case "--help":
		case "-h":
			process.stdout.write(USAGE);
			return;

		default:
			fail(`unknown command "${args.command}"\n\n${USAGE}`);
	}
}

main().catch((err: unknown) => {
	fail(err instanceof Error ? err.message : String(err));
});

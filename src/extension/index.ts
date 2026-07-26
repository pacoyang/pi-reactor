/**
 * The pi extension: configures pi-reactor by conversation
 *.
 *
 * This runs inside the OPERATOR's own interactive pi session, not inside the
 * daemon and not inside a job. It is deliberately a thin client — every tool
 * here is a JSON-RPC call and nothing more. Validation, atomic writes and hot
 * reload live in the daemon, which is what lets an old extension talk to a new
 * daemon and get an honest `-32601` instead of writing something inconsistent.
 *
 * Confirmation policy, enforced here because this is where a human is:
 *   - reads (status, runs, config listings)  -> no gate
 *   - reversible switches (pause / resume)   -> no gate
 *   - config changes                         -> gate, showing before -> after
 *   - emit                                   -> gate, because it spends money
 *
 * Unattended safety needs no code of its own. Batch jobs run with `-ne`, so this
 * extension is not loaded at all; and were it loaded, `ctx.ui.confirm` becomes an
 * `extension_ui_request` that the daemon answers `cancelled: true`, which
 * arrives here as `false` and refuses the write. Measured against a real pi.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { resolvePaths } from "../core/paths.ts";
import { callDaemon, DaemonUnavailableError } from "../core/rpc-client.ts";

const paths = resolvePaths();

async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
	return callDaemon({ socketPath: paths.sock }, method, params);
}

interface ToolResult {
	content: [{ type: "text"; text: string }];
	details: unknown;
}

/** Tool results are text; a failure is reported as text too, never thrown at the model. */
function text(value: unknown): ToolResult {
	const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return { content: [{ type: "text", text: body }], details: value };
}

/**
 * A daemon that is not running, or a refusal, is information the model should
 * act on — not an exception that ends the turn. Every tool here returns text.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<ToolResult> {
	try {
		return text(await fn());
	} catch (err) {
		if (err instanceof DaemonUnavailableError) {
			return text(`${err.message}\nStart it with: pi-reactor serve`);
		}
		return text(`refused: ${err instanceof Error ? err.message : String(err)}`);
	}
}

const KIND = Type.Union([Type.Literal("agent"), Type.Literal("sink"), Type.Literal("trigger")], {
	description: "Which kind of configuration entry",
});

export default function reactorConsole(pi: ExtensionAPI): void {
	// ------------------------------------------------------------- reads

	pi.registerTool({
		name: "reactor_status",
		label: "Reactor Status",
		description:
			"Show the pi-reactor daemon's status: uptime, queue depth, undelivered notifications, and today's token spend. " +
			"Read-only; call this first when the user asks whether anything is running or stuck.",
		promptSnippet: "Inspect the pi-reactor daemon's queue and spend",
		parameters: Type.Object({}),
		execute: () => guarded(() => call("status")),
	});

	pi.registerTool({
		name: "reactor_runs",
		label: "Reactor Runs",
		description:
			"List recent pi-reactor runs, newest first. Set failedOnly to see just the ones that failed or were " +
			"interrupted — that is usually what the user means by 'what went wrong'. Read-only.",
		promptSnippet: "List recent pi-reactor runs and their outcomes",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "How many runs, 1-200 (default 20)" })),
			failedOnly: Type.Optional(Type.Boolean({ description: "Only failed and interrupted runs" })),
		}),
		execute: (_id, params) =>
			guarded(() =>
				call("runs", {
					...(params.limit !== undefined ? { limit: params.limit } : {}),
					...(params.failedOnly ? { dead: true } : {}),
				}),
			),
	});

	pi.registerTool({
		name: "reactor_config_get",
		label: "Reactor Config",
		description:
			"Read pi-reactor's configuration: the agents that can run work, the sinks that notifications go to, or the " +
			"triggers that fire on a schedule. ALWAYS read the current entry before editing one — edits replace an entry " +
			"wholesale rather than patching it. Read-only; credential values are never returned.",
		promptSnippet: "Read pi-reactor's agents, sinks and triggers",
		parameters: Type.Object({ kind: KIND }),
		execute: (_id, params) => guarded(() => call(`${params.kind}.ls`)),
	});

	// ------------------------------------------------------------- writes

	pi.registerTool({
		name: "reactor_config_set",
		label: "Reactor Config Change",
		description:
			"Add, replace or delete one pi-reactor configuration entry. The change is validated by the daemon and shown " +
			"to the user for approval before anything is written; it takes effect immediately, with no restart. " +
			"For 'edit', pass the COMPLETE entry — read it with reactor_config_get first and change what you need. " +
			"Never put a token, key or secret in an entry: use the /reactor command to store credentials.",
		promptSnippet: "Change a pi-reactor trigger, agent or sink",
		promptGuidelines: [
			"Read the current configuration with reactor_config_get before changing it.",
			"A cron schedule is standard five-field crontab, optionally with a leading seconds field.",
			"Credentials never belong in a configuration entry; direct the user to /reactor to store one.",
		],
		parameters: Type.Object({
			kind: KIND,
			action: Type.Union([Type.Literal("add"), Type.Literal("edit"), Type.Literal("delete")]),
			name: Type.String({ description: "Agent or sink name, or trigger id" }),
			entry: Type.Optional(
				Type.Any({
					description:
						"The complete entry, for add and edit. Agent: {cwd, model:'provider/model-id', maxDuration?}. " +
						"Sink: {kind:'telegram', chatId}. Trigger: {on:{type:'cron', id, schedule, timezone?, " +
						"misfirePolicy?}, run:{agent, task|skill, maxDuration?}, notify?:{sink, when}}",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { kind, action, name } = params;
			const entry = params.entry as Record<string, unknown> | undefined;
			if (action !== "delete" && (entry === undefined || entry === null)) {
				return text(`refused: ${action} needs an "entry"`);
			}

			const method = `${kind}.${action === "delete" ? "delete" : action}`;
			const target = kind === "trigger" ? { id: name } : { name };
			const payload = action === "delete" ? {} : { [kind]: entry };
			const request = { ...target, ...payload };

			return guarded(async () => {
				// Validate first. What the user approves is therefore a document the
				// daemon has already accepted — approving something that then gets
				// rejected is worse than not asking.
				const preview = (await call(method, { ...request, dryRun: true })) as {
					before: string;
					after: string;
					changed: boolean;
					file: string;
				};
				if (!preview.changed) return "no change: the configuration already says that";

				const approved = await confirmChange(ctx.ui, `${action} ${kind} "${name}"`, preview);
				if (!approved) return "cancelled by the user; nothing was written";

				await call(method, request);
				return `applied to ${preview.file}, live now (no restart needed)`;
			});
		},
	});

	pi.registerTool({
		name: "reactor_emit",
		label: "Reactor Run Now",
		description:
			"Run one of pi-reactor's agents right now, without waiting for its schedule. This spends tokens, so the user " +
			"is asked to confirm. Use it to try out a task before putting it on a trigger.",
		promptSnippet: "Run a pi-reactor agent immediately",
		parameters: Type.Object({
			agent: Type.String({ description: "Which configured agent runs it" }),
			task: Type.String({ description: "What the agent should do" }),
			notify: Type.Optional(Type.String({ description: "Sink name to send the result to" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const approved = await ctx.ui.confirm(
				"Run now?",
				`agent: ${params.agent}\ntask: ${params.task}\n` +
					`${params.notify ? `notify: ${params.notify}\n` : ""}\nThis starts a real run and spends tokens.`,
			);
			if (!approved) return text("cancelled by the user; nothing was queued");

			return guarded(() =>
				call("emit", {
					route: { agent: params.agent, task: params.task },
					...(params.notify ? { notify: { sink: params.notify, when: "always" } } : {}),
				}),
			);
		},
	});

	pi.registerTool({
		name: "reactor_pause",
		label: "Reactor Pause",
		description:
			"Pause or resume pi-reactor's queue. Paused, jobs still enqueue but none start; the setting survives a " +
			"daemon restart. Reversible, so it needs no confirmation.",
		promptSnippet: "Pause or resume the pi-reactor queue",
		parameters: Type.Object({
			paused: Type.Boolean({ description: "true to pause, false to resume" }),
		}),
		execute: (_id, params) => guarded(() => call(params.paused ? "pause" : "resume")),
	});

	// ------------------------------------------------------------- /reactor

	pi.registerCommand("reactor", {
		description: "pi-reactor: status, credentials, pause and resume",
		getArgumentCompletions: (prefix) =>
			["status", "secret", "pause", "resume"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		async handler(args, ctx) {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (sub) {
					case "status": {
						const s = (await call("status")) as {
							pid: number;
							paused: boolean;
							queue: { pending: number; running: number };
							outbox: { pending: number; dead: number };
							today: { runs: number; totalTokens: number };
							agents: string[];
						};
						ctx.ui.notify(
							`pi-reactor pid ${s.pid}${s.paused ? " [PAUSED]" : ""} · ` +
								`queue ${s.queue.pending}/${s.queue.running} · outbox ${s.outbox.pending}` +
								`${s.outbox.dead > 0 ? ` (${s.outbox.dead} DEAD)` : ""} · ` +
								`today ${s.today.runs} runs, ${s.today.totalTokens} tokens · ` +
								`agents: ${s.agents.join(", ") || "(none yet)"}`,
							"info",
						);
						return;
					}

					case "pause":
					case "resume": {
						await call(sub);
						ctx.ui.notify(`queue ${sub === "pause" ? "paused" : "resumed"}`, "info");
						return;
					}

					case "secret": {
						// Credentials never pass through a tool, so they never enter the
						// model's context. This dialog is the only way in, and the
						// value goes straight to a 0600 file the daemon owns.
						const [name, field = "botToken"] = rest;
						if (!name) {
							ctx.ui.notify("usage: /reactor secret <sink-name> [field]  (default field: botToken)", "warning");
							return;
						}
						const value = await ctx.ui.input(`Paste the ${field} for "${name}"`, "not echoed, not stored in this session");
						if (!value) {
							ctx.ui.notify("cancelled", "info");
							return;
						}
						await call("credential.set", { name, field, value: value.trim() });
						ctx.ui.notify(`stored ${name}.${field} (0600, never shown again)`, "info");
						return;
					}

					default:
						ctx.ui.notify(`unknown: /reactor ${sub}  (status | secret | pause | resume)`, "warning");
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(
					err instanceof DaemonUnavailableError ? `${message}\nStart it with: pi-reactor serve` : message,
					"error",
				);
			}
		},
	});
}

/**
 * The confirmation gate: shows what actually changes, not just that something will.
 *
 * A line diff rather than both documents in full — a triggers.json with a dozen
 * entries would otherwise bury the one line that moved, and a gate nobody reads
 * is not a gate.
 */
async function confirmChange(
	ui: ExtensionUIContext,
	title: string,
	preview: { before: string; after: string; file: string },
): Promise<boolean> {
	return ui.confirm(title, `${preview.file}\n\n${diffLines(preview.before, preview.after)}`);
}

export function diffLines(before: string, after: string, context = 2): string {
	const a = before.split("\n");
	const b = after.split("\n");

	// Longest common prefix and suffix; everything between them is the change.
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

	const removed = a.slice(head, a.length - tail);
	const added = b.slice(head, b.length - tail);
	// Identical input still has context lines to print, so emptiness of the diff
	// has to be judged on the changed lines rather than on the output.
	if (removed.length === 0 && added.length === 0) return "(no textual change)";

	const lines: string[] = [];

	const leading = a.slice(Math.max(0, head - context), head);
	for (const line of leading) lines.push(`  ${line}`);
	for (const line of removed) lines.push(`- ${line}`);
	for (const line of added) lines.push(`+ ${line}`);
	const trailing = a.slice(a.length - tail, a.length - tail + context);
	for (const line of trailing) lines.push(`  ${line}`);

	return lines.join("\n");
}

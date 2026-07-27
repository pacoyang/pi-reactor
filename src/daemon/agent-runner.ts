/**
 * Spawns and drives one `pi --mode rpc` child process through a single run
 *.
 *
 * Hand-written rather than using the upstream `RpcClient`: that one does
 * `{...process.env, ...env}` unconditionally, which defeats the job-env allowlist
 *. Protocol semantics mirror it; the contract test still
 * anchors on upstream.
 *
 * Six hard constraints, each established by running against the pinned 0.82.1:
 *  1. Completion is `agent_settled` ONLY. `agent_end` can be followed by a retry
 *     or continuation, and `prompt`'s response is just a preflight ack.
 *  2. Frames must be split on LF only. Upstream dropped readline because U+2028
 *     and U+2029 are legal inside JSON strings and readline splits on them.
 *  3. stdout must be drained continuously: the agent loop awaits stdout
 *     backpressure, so a slow reader slows the agent down.
 *  4. The last assistant text must be cached as events arrive. After SIGKILL the
 *     RPC channel is gone and `get_last_assistant_text` is unavailable, so this
 *     cache is the only source for a failure notification body.
 *  5. `get_last_assistant_text` returns `data:{}` when there is no text — `text`
 *     is undefined, not null.
 *  6. A dialog opened during `session_start` deadlocks RPC unconditionally
 *     (rpc-mode.js binds the stdin reader after rebindSession), so no
 *     auto-answer policy can rescue it; the only defence is `-ne` plus a probe.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { AgentProfile } from "../core/config.ts";
import type { Logger } from "./logger.ts";
import { errorSummary } from "./logger.ts";

/**
 * Locates the upstream RPC entry through the package's public `./rpc-entry`
 * export rather than assembling a dist path: exports are the contract, internal
 * layout is not.
 *
 * Must use `import.meta.resolve` — that subpath has an `import` condition but no
 * `require` one, so `createRequire().resolve()` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED (measured 2026-07-26, same as
 * `@earendil-works/pi-ai/compat`).
 */
export function resolveRpcEntry(): string {
	return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface RunResult {
	/** Whether `agent_settled` arrived. False means the process died first. */
	settled: boolean;
	/** Last assistant text; null for a run that produced none. */
	lastText: string | null;
	usage: UsageTotals;
	stopReason?: string | undefined;
	errorMessage?: string | undefined;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	/** We drove the termination chain because maxDuration elapsed. */
	timedOut: boolean;
	/** pi's session JSONL path. The reaper deletes only sessions listed here. */
	sessionFile?: string | undefined;
	pid?: number | undefined;
	durationMs: number;
}

export interface RunAgentOptions {
	agent: AgentProfile;
	task: string;
	env: Record<string, string>;
	maxDurationMs: number;
	logger: Logger;
	/** Injection point: tests aim at a fixture, production uses resolveRpcEntry(). */
	rpcEntry?: string;
	/** Startup probe budget — the only defence against the session_start deadlock. */
	startupProbeMs?: number;
	/** The two grace windows of the termination chain; exposed to keep tests fast. */
	abortGraceMs?: number;
	termGraceMs?: number;
	/**
	 * Where pi writes this run's session JSONL.
	 *
	 * Unset in production on purpose: job transcripts then land in the operator's
	 * normal session list, which is what lets `pi --resume` find them and what
	 * `pi-reactor resume` builds on. Tests set it to their own temp directory —
	 * otherwise every contract run leaves a directory behind in the operator's
	 * real session history, and cleaning up after a test is the test's job.
	 */
	sessionDir?: string;
}

const DEFAULTS = { startupProbeMs: 30_000, abortGraceMs: 30_000, termGraceMs: 10_000 };

/** How long to wait for a clean exit after `stdin.end()` before escalating. */
const CLEAN_EXIT_GRACE_MS = 5_000;

interface Frame {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: Record<string, unknown>;
	method?: string;
	message?: Record<string, unknown>;
}

interface ExitStatus {
	code: number | null;
	signal: NodeJS.Signals | null;
}

export async function runAgent(options: RunAgentOptions): Promise<RunResult> {
	const startupProbeMs = options.startupProbeMs ?? DEFAULTS.startupProbeMs;
	const abortGraceMs = options.abortGraceMs ?? DEFAULTS.abortGraceMs;
	const termGraceMs = options.termGraceMs ?? DEFAULTS.termGraceMs;
	const log = options.logger;
	const startedAt = Date.now();

	const args = buildArgs(options.agent, options.rpcEntry ?? resolveRpcEntry(), options.sessionDir);
	const child = spawn(process.execPath, args, {
		cwd: options.agent.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	// ---------------------------------------------------------------- state
	let settled = false;
	let lastText: string | null = null;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let sessionFile: string | undefined;
	let stderrTail = "";
	const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

	const pending = new Map<string, (frame: Frame) => void>();
	const settledWaiters: Array<() => void> = [];
	let nextId = 0;

	child.stderr?.on("data", (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-2000);
	});

	// ------------------------------------------------- LF-only JSONL reader (#2)
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += decoder.write(chunk);
		let index: number;
		// Drain fully on every tick (#3): never leave frames buffered for later.
		while ((index = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (line === "") continue;
			let frame: Frame;
			try {
				frame = JSON.parse(line) as Frame;
			} catch {
				continue; // non-JSON line: ignore, never fatal
			}
			handleFrame(frame);
		}
	});

	function handleFrame(frame: Frame): void {
		// 1. Response correlated by id.
		if (frame.type === "response" && typeof frame.id === "string") {
			const resolve = pending.get(frame.id);
			if (resolve) {
				pending.delete(frame.id);
				resolve(frame);
				return;
			}
		}

		// 2. Extension dialog: always answer cancel. Measured safe defaults —
		//    confirm resolves false, select/input resolve undefined, so the
		//    extension sees "user cancelled" and does not crash.
		if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
			const fireAndForget = frame.method === "notify" || frame.method === "setStatus"
				|| frame.method === "setWidget" || frame.method === "setTitle"
				|| frame.method === "set_editor_text";
			if (!fireAndForget) {
				send({ type: "extension_ui_response", id: frame.id, cancelled: true });
			}
			return;
		}

		// 3. Event stream.
		if (frame.type === "message_end") {
			const message = frame.message;
			if (message && message.role === "assistant") {
				const text = extractText(message.content);
				// Cache as it arrives (#4): after SIGKILL this is the only body source.
				if (text) lastText = text;
				if (typeof message.stopReason === "string") stopReason = message.stopReason;
				if (typeof message.errorMessage === "string" && message.errorMessage !== "") {
					errorMessage = message.errorMessage;
				}
				accumulateUsage(usage, message.usage);
			}
			return;
		}

		// 4. Completion signal — `agent_settled` only (#1).
		if (frame.type === "agent_settled") {
			settled = true;
			for (const wake of settledWaiters.splice(0)) wake();
		}
	}

	function send(payload: unknown): void {
		if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	function call(type: string, fields: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Frame> {
		const id = `r${++nextId}`;
		return new Promise<Frame>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`timeout waiting for response to ${type}`));
			}, timeoutMs);
			timer.unref();
			pending.set(id, (frame) => {
				clearTimeout(timer);
				resolve(frame);
			});
			send({ id, type, ...fields });
		});
	}

	// `exit` OR `error`, then a bounded wait for `close`.
	//
	// Not `close` alone. `close` fires when the last holder of the stdio pipes lets
	// go, and a grandchild inherits them: measured 2026-07-26, a child that spawns
	// a detached process inheriting stdout emits `exit` after 19ms and `close`
	// never. Every terminal path here awaits this promise, so `close` alone meant a
	// job whose agent left `npm run dev &` behind held its worker slot forever and
	// drain() could only time out.
	//
	// Not `exit` alone either: a failed spawn (ENOENT and friends) emits
	// `error` + `close` but NEVER `exit` (measured), which is what put us on `close`
	// in the first place.
	//
	// The short wait for `close` after `exit` is what keeps the clean path honest:
	// the final frames — `agent_settled` above all — may still be in the pipe, and
	// resolving before they are parsed would classify a success as a crash. Normally
	// `close` follows `exit` within a tick, so this costs nothing.
	const STDOUT_FLUSH_GRACE_MS = 2_000;
	let exitStatus: ExitStatus | undefined;
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	const exited = new Promise<ExitStatus>((resolve) => {
		const settleExit = (status: ExitStatus): void => {
			if (exitStatus) return;
			exitStatus = status;
			void Promise.race([
				closed,
				new Promise<void>((r) => {
					const t = setTimeout(r, STDOUT_FLUSH_GRACE_MS);
					t.unref();
				}),
			]).then(() => {
				// Let go of our ends; whatever the agent left behind keeps its own.
				child.stdout?.destroy();
				child.stderr?.destroy();
				resolve(status);
			});
		};
		child.once("exit", (code, signal) => settleExit({ code, signal }));
		child.once("error", (err) => {
			errorMessage ??= errorSummary(err);
			settleExit({ code: null, signal: null });
		});
	});

	/** True once the child is known to be gone. */
	const isGone = (): boolean => exitStatus !== undefined;

	// ------------------------------------------------- startup probe (#6)
	// Two startup failures converge here:
	//  a) a session_start dialog deadlocks the RPC loop — no command ever gets a
	//     reply, so only a timeout can detect it;
	//  b) the process exits outright, e.g. `-ne` disabled the extension that
	//     registers the provider, so pi prints `Unknown provider` and leaves.
	//     This MUST race process exit, otherwise a process that dies in one
	//     second still burns the whole probe budget.
	const probe = await Promise.race([
		call("get_state", {}, startupProbeMs).then(
			(frame) => ({ kind: "ok" as const, frame }),
			() => ({ kind: "timeout" as const }),
		),
		exited.then((end) => ({ kind: "died" as const, end })),
	]);

	if (probe.kind !== "ok") {
		const detail = probe.kind === "died"
			? `pi exited during startup (code=${probe.end.code} signal=${probe.end.signal})`
			: "startup probe timed out (an extension dialog during session_start deadlocks RPC)";
		log.error("agent_startup_failed", {
			pid: child.pid,
			kind: probe.kind,
			detail,
			stderr: stderrTail.trim().slice(-400),
		});
		if (probe.kind === "timeout") await terminate(child, exited, isGone, 0, 0);
		const end = await exited;
		// The stderr tail usually carries the real cause ("Unknown provider ...").
		const hint = stderrTail.trim().split("\n").filter(Boolean).at(-1);
		return finish(end, false, hint ? `${detail}: ${hint}` : detail);
	}

	const file = probe.frame.data?.sessionFile;
	if (typeof file === "string") sessionFile = file;
	log.debug("agent_started", { pid: child.pid, sessionFile });

	// ------------------------------------------------- prompt, then await settled
	const settledPromise = new Promise<void>((resolve) => {
		if (settled) return resolve();
		settledWaiters.push(resolve);
	});

	const promptResponse = await Promise.race([
		call("prompt", { message: options.task }, 60_000).catch((cause: unknown) => {
			errorMessage ??= errorSummary(cause);
			return undefined;
		}),
		// Race the exit for the same reason the startup probe does: a process that
		// dies here would otherwise hold its concurrency slot for the full call
		// timeout while there is provably nothing left to answer.
		exited.then(() => undefined),
	]);
	// `prompt`'s response is only a preflight ack, not completion. But an explicit
	// success:false means delivery itself failed (e.g. "No API key found"), and
	// there is nothing to wait for.
	if (promptResponse?.success === false) {
		errorMessage ??= promptResponse.error ?? "prompt refused";
		log.warn("agent_prompt_refused", { pid: child.pid, error: errorMessage });
		await terminate(child, exited, isGone, 0, 0);
		return finish(await exited, false);
	}

	// ------------------------------------------------- termination chain
	const timeout = new Promise<"timeout">((resolve) => {
		const timer = setTimeout(() => resolve("timeout"), options.maxDurationMs);
		timer.unref();
	});

	const outcome = await Promise.race([
		settledPromise.then(() => "settled" as const),
		exited.then(() => "exited" as const),
		timeout,
	]);

	let timedOut = false;
	if (outcome === "timeout") {
		timedOut = true;
		log.warn("agent_timeout", { pid: child.pid, maxDurationMs: options.maxDurationMs });
		await call("abort", {}, 5_000).catch(() => undefined);

		// An abort that lands makes the agent settle but NOT exit — it goes back to
		// waiting on stdin. Measured end to end: without this branch a timed-out job
		// sat through the entire 30s abort grace before SIGTERM, holding a
		// concurrency slot for nothing. Closing stdin takes the same process down
		// gracefully in about a second.
		const abortSettled = await Promise.race([
			settledPromise.then(() => true),
			exited.then(() => true),
			new Promise<boolean>((resolve) => {
				const t = setTimeout(() => resolve(false), abortGraceMs);
				t.unref();
			}),
		]);

		if (abortSettled && !isGone()) {
			child.stdin?.end();
			if (!(await raceExit(exited, termGraceMs))) {
				await terminate(child, exited, isGone, 0, termGraceMs);
			}
		} else {
			// abort never took: escalate through signals.
			await terminate(child, exited, isGone, 0, termGraceMs);
		}
	} else if (outcome === "settled") {
		// Clean path: prefer the authoritative text over the cache, then let the
		// process exit by closing stdin (its graceful path, exit 0).
		const got = await call("get_last_assistant_text", {}, 10_000).catch(() => undefined);
		const text = got?.data?.text;
		if (typeof text === "string" && text !== "") lastText = text;
		child.stdin?.end();
		if (!(await raceExit(exited, CLEAN_EXIT_GRACE_MS))) {
			// stdin.end() did not take; escalate rather than leak the process.
			log.warn("agent_clean_exit_timeout", { pid: child.pid });
			await terminate(child, exited, isGone, 0, termGraceMs);
		}
	}

	// Always report the real exit status: awaiting `exited` here is safe because
	// every branch above has either observed the exit or driven termination to
	// completion (which itself ends with SIGKILL).
	return finish(await exited, settled, undefined, timedOut);

	function finish(end: ExitStatus, didSettle: boolean, error?: string, wasTimedOut = false): RunResult {
		if (error) errorMessage ??= error;
		return {
			settled: didSettle,
			lastText,
			usage,
			stopReason,
			errorMessage,
			exitCode: end.code,
			signal: end.signal,
			timedOut: wasTimedOut,
			sessionFile,
			pid: child.pid,
			durationMs: Date.now() - startedAt,
		};
	}
}

// ---------------------------------------------------------------- helpers

export function buildArgs(agent: AgentProfile, rpcEntry: string, sessionDir?: string): string[] {
	const args = [rpcEntry];
	// Redirects where pi stores this session; see RunAgentOptions.sessionDir.
	if (sessionDir) args.push("--session-dir", sessionDir);
	// `-ne` is mandatory: without it the global ~/.pi/agent/extensions are loaded
	// automatically and pollute a batch job. Extensions the profile asks for are
	// added back explicitly. Note that a provider registered BY an extension needs
	// that extension in the allowlist, or pi exits with "Unknown provider".
	args.push("-ne");
	for (const ext of agent.extensions) args.push("-e", ext);
	args.push("--provider", agent.provider, "--model", agent.modelId);
	if (agent.thinkingLevel) args.push("--thinking", agent.thinkingLevel);
	return args;
}

function extractText(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const t = (block as { text?: unknown }).text;
			if (typeof t === "string") parts.push(t);
		}
	}
	const joined = parts.join("").trim();
	return joined === "" ? null : joined;
}

/**
 * Sums usage across every assistant message of the run. Double counting is not a
 * concern: internal provider retries genuinely spend those tokens, and the budget
 * gate wants the real total.
 */
function accumulateUsage(totals: UsageTotals, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const u = raw as Record<string, unknown>;
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	totals.input += num(u.input);
	totals.output += num(u.output);
	totals.cacheRead += num(u.cacheRead);
	totals.cacheWrite += num(u.cacheWrite);
	totals.total += num(u.totalTokens);
}

/** Signal half of the termination chain: SIGTERM, grace, then SIGKILL. */
async function terminate(
	child: ChildProcess,
	exited: Promise<ExitStatus>,
	isGone: () => boolean,
	abortGraceMs: number,
	termGraceMs: number,
): Promise<void> {
	if (isGone()) return;
	if (abortGraceMs > 0 && (await raceExit(exited, abortGraceMs))) return;

	if (!isGone()) child.kill("SIGTERM");
	if (termGraceMs > 0 && (await raceExit(exited, termGraceMs))) return;

	if (!isGone()) child.kill("SIGKILL");
	await raceExit(exited, CLEAN_EXIT_GRACE_MS);
}

/** Resolves true if the process exited within `ms`. */
function raceExit(exited: Promise<ExitStatus>, ms: number): Promise<boolean> {
	return Promise.race([
		exited.then(() => true),
		new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), ms);
			timer.unref();
		}),
	]);
}

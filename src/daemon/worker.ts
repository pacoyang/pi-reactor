/**
 * The claim loop: takes one job at a time and drives it to a terminal state
 *.
 *
 * Shape per job:
 *   claim (BEGIN IMMEDIATE) -> preflight gates -> spawn -> await agent_settled
 *   -> classify -> terminal transaction (job + run + outbox together)
 *
 * Everything expensive happens after the gates, and the gates are pure functions
 * over injected dependencies so their ORDER is unit-testable without spawning
 * anything.
 */
import type { Db } from "../core/db.ts";
import { nowIso } from "../core/db.ts";
import type { AgentProfile, Config, NotifyWhen } from "../core/config.ts";
import type { Paths } from "../core/paths.ts";
import { resolveProviderCredential } from "../core/credentials.ts";
import { runAgent } from "./agent-runner.ts";
import { buildJobEnv } from "./job-env.ts";
import { preflight, makeGitDirtyCheck, type PreflightDeps } from "./preflight.ts";
import { classify, refused, shouldRetry, backoffSeconds, withJitter, type Classification } from "./outcome.ts";
import { claimNextJob, finishJob, tokensSpentToday, isPaused, type JobRow } from "./store.ts";
import { formatDuration } from "../core/duration.ts";
import type { JobTokens } from "./job-tokens.ts";
import type { Logger } from "./logger.ts";
import { errorSummary } from "./logger.ts";
import { execFileSync } from "node:child_process";

export interface WorkerOptions {
	db: Db;
	paths: Paths;
	logger: Logger;
	getConfig: () => Config;
	concurrency: number;
	dailyTokenCap: number | null;
	softLimitRatio: number;
	/** Poll interval for the claim loop. */
	tickMs?: number;
	/**
	 * Reports a cron job's terminal outcome so the breaker can count consecutive
	 * failures. Injected rather than imported so the worker stays testable
	 * without a scheduler.
	 */
	onTriggerOutcome?: (triggerId: string, succeeded: boolean) => void;
	/**
	 * Points spawns at a stand-in RPC agent. Tests only: production always
	 * resolves the package export so there is no way to accidentally ship a
	 * daemon that talks to something other than pi.
	 */
	rpcEntryOverride?: string;
	/**
	 * Grace windows of the termination chain: abort, then SIGTERM, then
	 * SIGKILL. Configurable because the right pause depends on the work — an
	 * agent mid tool-call deserves longer than a health check.
	 */
	abortGraceMs?: number;
	termGraceMs?: number;
	/** Mints and revokes the per-job token that gates `schedule.*`. */
	jobTokens?: JobTokens;
}

export interface Worker {
	start(): void;
	/** Stops claiming new work; resolves once in-flight jobs finish or the deadline passes. */
	drain(graceMs: number): Promise<{ drained: boolean; inFlight: number }>;
	inFlight(): number;
}

const DEFAULT_TICK_MS = 1000;

export function createWorker(options: WorkerOptions): Worker {
	const { db, paths, logger, getConfig, concurrency } = options;
	const tickMs = options.tickMs ?? DEFAULT_TICK_MS;

	let running = false;
	let accepting = true;
	let timer: NodeJS.Timeout | undefined;
	const active = new Set<Promise<void>>();

	const gitDirty = makeGitDirtyCheck((cmd, args, cwd) =>
		execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
	);

	function tick(): void {
		if (!accepting) return;
		// Pause is durable and lives in the database, so a paused daemon comes back
		// paused after a restart. Jobs still enqueue; they simply wait.
		if (isPaused(db)) return;
		if (active.size >= concurrency) return;

		let job: JobRow | null;
		try {
			job = claimNextJob(db, concurrency);
		} catch (err) {
			logger.error("claim_failed", { error: errorSummary(err) });
			return;
		}
		if (!job) return;

		const promise = processJob(job).finally(() => {
			active.delete(promise);
			// A slot freed up; try immediately rather than waiting out the tick.
			if (accepting) setImmediate(tick);
		});
		active.add(promise);
		// More capacity may be available for another agent right now.
		if (active.size < concurrency) setImmediate(tick);
	}

	async function processJob(job: JobRow): Promise<void> {
		const startedAt = nowIso();
		const log = logger.child({ jobId: job.id, agent: job.agent });
		const config = getConfig();
		const agent = config.agents[job.agent];

		if (!agent) {
			// The agent was removed from config while this job sat in the queue.
			log.warn("job_agent_missing");
			settle(job, startedAt, refused("config_error"), {
				errorSummary: `agent "${job.agent}" is no longer defined in agents.json`,
			});
			return;
		}

		const gateResult = await runGates(job, agent, log);
		if (!gateResult.ok) {
			log.warn("job_refused", { reason: gateResult.reason, detail: gateResult.detail });
			settle(job, startedAt, refused(gateResult.reason), { errorSummary: gateResult.detail });
			return;
		}

		const task = buildTask(job);
		const env = buildJobEnv({
			agent,
			jobId: job.id,
			socketPath: paths.sock,
			providerVars: gateResult.providerVars,
			...(options.jobTokens ? { token: options.jobTokens.issue(job.id) } : {}),
		});

		log.info("job_started", { maxDurationS: job.max_duration_s });
		try {
			const result = await runAgent({
				agent,
				task,
				env,
				maxDurationMs: job.max_duration_s * 1000,
				logger: log,
				...(options.rpcEntryOverride !== undefined ? { rpcEntry: options.rpcEntryOverride } : {}),
				...(options.abortGraceMs !== undefined ? { abortGraceMs: options.abortGraceMs } : {}),
				...(options.termGraceMs !== undefined ? { termGraceMs: options.termGraceMs } : {}),
			});
			const classification = classify(result);
			log.info("job_finished", {
				outcome: classification.outcome,
				reason: classification.reason,
				tokens: result.usage.total,
				durationMs: result.durationMs,
			});
			settle(job, startedAt, classification, {
				...(result.errorMessage !== undefined ? { errorSummary: result.errorMessage } : {}),
				...(result.pid !== undefined ? { pid: result.pid } : {}),
				...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
				usage: result.usage,
				lastText: result.lastText,
				durationMs: result.durationMs,
			});
		} catch (err) {
			// runAgent should not throw, but a spawn-layer surprise must still end
			// the job rather than leave it running forever.
			log.error("job_crashed", { error: errorSummary(err) });
			settle(job, startedAt, { outcome: "failed", reason: "crash", retryable: true }, {
				errorSummary: errorSummary(err),
			});
		}
	}

	async function runGates(
		job: JobRow,
		agent: AgentProfile,
		log: Logger,
	): Promise<{ ok: true; providerVars: Record<string, string> } | { ok: false; reason: "config_error" | "budget_exceeded"; detail: string }> {
		const deps: PreflightDeps = {
			resolveProvider: (provider) => resolveProviderCredential(provider, { credentialsFile: paths.credentialsFile }),
			isDirty: gitDirty,
			spentToday: () => tokensSpentToday(db),
			dailyCap: options.dailyTokenCap,
			softLimitRatio: options.softLimitRatio,
			onSoftLimit: (spent, cap) => log.warn("budget_soft_limit", { spent, cap }),
		};
		return preflight({ agent, requireCleanTree: job.require_clean_tree === 1 }, deps);
	}

	interface SettleExtras {
		errorSummary?: string;
		pid?: number;
		sessionFile?: string;
		usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		lastText?: string | null;
		durationMs?: number;
	}

	function settle(job: JobRow, startedAt: string, classification: Classification, extras: SettleExtras): void {
		const retry = shouldRetry(classification, job.retryable === 1, job.attempts);
		const notify = buildNotification(job, classification, extras, retry);

		// The token dies with the run, whatever the outcome.
		options.jobTokens?.revoke(job.id);

		let settled: { alreadySettled: boolean };
		try {
			settled = finishJob(db, {
				jobId: job.id,
				agent: job.agent,
				outcome: classification.outcome,
				...(classification.reason !== undefined ? { reason: classification.reason } : {}),
				...(extras.errorSummary !== undefined ? { errorSummary: extras.errorSummary } : {}),
				...(extras.pid !== undefined ? { pid: extras.pid } : {}),
				...(extras.sessionFile !== undefined ? { sessionFile: extras.sessionFile } : {}),
				...(extras.usage !== undefined ? { usage: extras.usage } : {}),
				startedAt,
				...(notify !== undefined ? { notify } : {}),
				...(retry
					? { retryAt: new Date(Date.now() + withJitter(backoffSeconds(job.attempts)) * 1000).toISOString() }
					: {}),
			});
		} catch (err) {
			logger.error("settle_failed", { jobId: job.id, error: errorSummary(err) });
			return;
		}

		if (settled.alreadySettled) {
			// Shutdown reached this job first and already told the operator it was
			// interrupted. Saying anything more would contradict that — including
			// to the breaker, which would otherwise count a verdict we do not own.
			logger.warn("settle_skipped", { jobId: job.id, outcome: classification.outcome });
			return;
		}

		// A pending retry is not yet a verdict, so the breaker must not count it.
		//
		// Neither does a budget refusal. The breaker's premise is that a broken job eats the
		// whole daily budget every day — but a refusal never spawned anything, and
		// the condition it refused on clears by itself at midnight. Counting it would
		// leave the schedule dark long after the cap reset, waiting on a manual
		// `schedule resume` for a problem that fixed itself.
		if (job.trigger_id && !retry && classification.reason !== "budget_exceeded") {
			options.onTriggerOutcome?.(job.trigger_id, classification.outcome === "succeeded");
		}
	}

	/**
	 * Decides whether this outcome notifies, and renders the body.
	 *
	 * A retry is deliberately silent: the run has not reached a verdict yet, and
	 * notifying on every attempt is exactly the alert fatigue the breaker exists
	 * to prevent.
	 */
	function buildNotification(
		job: JobRow,
		c: Classification,
		extras: SettleExtras,
		retrying: boolean,
	): { sink: string; body: (runId: number) => string } | undefined {
		if (retrying) return undefined;
		if (!job.notify_sink || !job.notify_when) return undefined;
		const when = job.notify_when as NotifyWhen;
		const succeeded = c.outcome === "succeeded";
		if (when === "success" && !succeeded) return undefined;
		if (when === "failure" && succeeded) return undefined;

		const label = job.trigger_id ?? `job ${job.id}`;
		const duration = extras.durationMs !== undefined ? formatDuration(Math.round(extras.durationMs / 1000)) : "";
		const tokens = extras.usage?.total ? `${(extras.usage.total / 1000).toFixed(1)}k tokens` : "";
		const meta = [job.agent, duration, tokens].filter(Boolean).join(" · ");

		/**
		 * The line that closes the loop: a notification you can act on.
		 *
		 * Without it, "this is interesting, let me ask a follow-up" means finding
		 * the run by its timestamp and then reading a path out of the database by
		 * hand — the notification only got you halfway. Only added when there IS a
		 * transcript: a run that died before pi wrote one has nothing to resume.
		 */
		const resumeHint = (runId: number): string =>
			extras.sessionFile ? `\n\n↩ pi-reactor resume ${runId}` : "";

		if (succeeded) {
			const body = extras.lastText?.trim() || "(no output)";
			return { sink: job.notify_sink, body: (runId) => `✅ ${label} · ${meta}\n\n${body}${resumeHint(runId)}` };
		}

		// Failure body comes from the cached event-stream text plus the error
		// summary: after SIGKILL the RPC channel is gone and nothing else remains.
		const parts = [`${head(c)} ${label} · ${meta || job.agent} · ${c.reason ?? "failed"}`];
		if (extras.errorSummary) parts.push("", extras.errorSummary);
		if (extras.lastText?.trim()) parts.push("", `last output: ${extras.lastText.trim()}`);
		// A failure is where the follow-up matters most — the transcript says what
		// it was doing when it stopped.
		return { sink: job.notify_sink, body: (runId) => `${parts.join("\n")}${resumeHint(runId)}` };
	}

	function head(c: Classification): string {
		if (c.reason === "timeout") return "⏱";
		if (c.outcome === "interrupted") return "⚠️";
		return "❌";
	}

	/**
	 * The prompt the agent receives: the operator's instruction, plus the event
	 * that caused it when there is one.
	 *
	 * A webhook-triggered task is unusable without this. "fix the issue" does not
	 * say which issue, in which repository, or what it says — that lives in the
	 * event, and inlining it is why the provider projection is kept small enough
	 * to inline (a raw GitHub payload is tens of kilobytes; ours is under one).
	 *
	 * Appended to the prompt rather than handed over in an environment variable:
	 * a batch job runs with `-ne`, so nothing is loaded that could surface a
	 * variable to the model, and an agent that has to be told to go read its own
	 * environment first is one indirection away from not doing it.
	 */
	function buildTask(job: JobRow): string {
		const instruction = job.task ? job.task : job.skill ? `/skill:${job.skill}` : "";
		const event = eventContext(job);
		return event ? `${instruction}\n\n${event}` : instruction;
	}

	function eventContext(job: JobRow): string | undefined {
		if (!job.event_data) return undefined;
		let data: unknown;
		try {
			data = JSON.parse(job.event_data);
		} catch {
			return undefined; // never let a malformed row stop a run
		}
		if (typeof data !== "object" || data === null || Object.keys(data).length === 0) return undefined;
		return `The event that triggered this run:\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
	}

	return {
		start() {
			if (running) return;
			running = true;
			timer = setInterval(tick, tickMs);
			timer.unref();
			setImmediate(tick);
		},

		async drain(graceMs) {
			accepting = false;
			if (timer) clearInterval(timer);
			if (active.size === 0) return { drained: true, inFlight: 0 };

			logger.info("worker_draining", { inFlight: active.size, graceMs });
			const settled = await Promise.race([
				Promise.allSettled([...active]).then(() => true),
				new Promise<boolean>((resolve) => {
					const t = setTimeout(() => resolve(false), graceMs);
					t.unref();
				}),
			]);
			return { drained: settled, inFlight: active.size };
		},

		inFlight: () => active.size,
	};
}

/**
 * Every SQL statement the daemon issues, in one place.
 *
 * Keeping them together means the transaction boundaries — which are the real
 * correctness surface here — can be read side by side instead of hunted across
 * modules. The daemon is the sole writer, so `BEGIN IMMEDIATE` is the only
 * concurrency control required.
 */
import type { Db } from "../core/db.ts";
import { nowIso, isoSecondsAgo, withTransaction } from "../core/db.ts";
import type { CloudEvent } from "../core/cloudevents.ts";
import type { NotifyWhen } from "../core/config.ts";

export interface EnqueueInput {
	event: CloudEvent;
	lane: "interactive" | "batch";
	agent: string;
	task?: string | undefined;
	skill?: string | undefined;
	triggerId?: string | undefined;
	maxDurationS: number;
	requireCleanTree: boolean;
	retryable: boolean;
	notify?: { sink: string; when: NotifyWhen } | undefined;
	/**
	 * Advances a schedule's watermark in the SAME transaction as the insert.
	 *
	 * Two separate writes would leave a crash window in which the job exists but
	 * the watermark does not, so misfire recovery re-derives the occurrence and
	 * enqueues it a second time. The deterministic event id normally catches that,
	 * but only if both paths derive the same instant (see scheduler.arm).
	 */
	watermark?: { triggerId: string; firedAt: Date } | undefined;
}

export interface EnqueueResult {
	seq: number;
	jobId: number | null;
	duplicate: boolean;
}

export interface JobRow {
	id: number;
	agent: string;
	task: string | null;
	skill: string | null;
	trigger_id: string | null;
	attempts: number;
	max_duration_s: number;
	require_clean_tree: number;
	retryable: number;
	notify_sink: string | null;
	notify_when: string | null;
	/**
	 * The event's `data`, as stored.
	 *
	 * Carried on the claim rather than fetched separately because a job triggered
	 * by a webhook is meaningless without it: "fix the issue" does not say which
	 * issue, in which repository. A cron fire has none and this stays "{}".
	 */
	event_data: string;
	/**
	 * The run row opened for this attempt, in the claim transaction itself.
	 *
	 * The row used to be inserted only at settle time, which meant a daemon
	 * SIGKILLed mid-run left no record of the session it had opened — the one
	 * transcript the operator most wants to resume. Opening the row at claim and
	 * filling it in as facts arrive (recordRunStart) closes that hole.
	 */
	runId: number;
}

/**
 * Writes the event and its job in ONE transaction.
 *
 * A duplicate (source,id) is an idempotent success, not an error: cron catch-up
 * and webhook redelivery both legitimately replay a key, and the caller must not
 * treat that as something to retry. Returning the existing seq lets them
 * correlate anyway.
 */
export function enqueue(db: Db, input: EnqueueInput): EnqueueResult {
	return withTransaction(db, () => {
		// One check, inside the transaction. An extra read beforehand would add a
		// third layer to an invariant the unique index already owns, and could only
		// ever be stale by the time the write lock is held.
		const existing = db
			.prepare("SELECT seq FROM events WHERE ce_source = ? AND ce_id = ?")
			.get(input.event.source, input.event.id) as { seq: number } | undefined;
		if (existing) {
			// A duplicate still advances the watermark: the occurrence demonstrably
			// landed, and leaving the watermark behind would re-derive it forever.
			advanceWatermark(db, input.watermark);
			return { seq: existing.seq, jobId: null, duplicate: true };
		}

		const eventInfo = db
			.prepare(
				`INSERT INTO events (ce_id, ce_source, ce_type, ce_time, lane, data, received_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.event.id,
				input.event.source,
				input.event.type,
				input.event.time ?? null,
				input.lane,
				JSON.stringify(input.event.data ?? {}),
				nowIso(),
			);
		const seq = Number(eventInfo.lastInsertRowid);

		const jobInfo = db
			.prepare(
				`INSERT INTO jobs (event_seq, agent, task, skill, trigger_id, max_duration_s,
				                   require_clean_tree, retryable, notify_sink, notify_when, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				seq,
				input.agent,
				input.task ?? null,
				input.skill ?? null,
				input.triggerId ?? null,
				input.maxDurationS,
				input.requireCleanTree ? 1 : 0,
				input.retryable ? 1 : 0,
				input.notify?.sink ?? null,
				input.notify?.when ?? null,
				nowIso(),
			);

		advanceWatermark(db, input.watermark);
		return { seq, jobId: Number(jobInfo.lastInsertRowid), duplicate: false };
	});
}

function advanceWatermark(db: Db, watermark: EnqueueInput["watermark"]): void {
	if (!watermark) return;
	db.prepare("UPDATE schedules SET last_fired_at = ?, updated_at = ? WHERE trigger_id = ?")
		.run(watermark.firedAt.toISOString(), nowIso(), watermark.triggerId);
}

/**
 * Claims the next runnable job, or null.
 *
 * Three conditions, expressed in the SQL rather than in JavaScript so the whole
 * decision is atomic under `BEGIN IMMEDIATE`:
 *   - pending and past its backoff time
 *   - no other job for the same agent is running (same cwd, so serialise writes)
 *   - total running below the global concurrency limit
 */
export function claimNextJob(db: Db, concurrency: number): JobRow | null {
	return withTransaction(db, () => {
		const running = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'running'").get() as { n: number };
		if (running.n >= concurrency) return null;

		const row = db
			.prepare(
				`SELECT j.id, j.agent, j.task, j.skill, j.trigger_id, j.attempts, j.max_duration_s,
				        j.require_clean_tree, j.retryable, j.notify_sink, j.notify_when,
				        e.data AS event_data
				 FROM jobs j JOIN events e ON e.seq = j.event_seq
				 WHERE j.state = 'pending'
				   AND (j.scheduled_at IS NULL OR j.scheduled_at <= ?)
				   AND j.agent NOT IN (SELECT agent FROM jobs WHERE state = 'running')
				 ORDER BY j.created_at, j.id
				 LIMIT 1`,
			)
			.get(nowIso()) as JobRow | undefined;

		if (!row) return null;

		const ts = nowIso();
		db.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?").run(ts, row.id);
		// One run row per attempt, open (outcome NULL) until settled. Same
		// transaction as the state flip: `state='running'` and "exactly one open
		// run row" are a single invariant, not two.
		const runInfo = db
			.prepare("INSERT INTO runs (job_id, agent, started_at) VALUES (?, ?, ?)")
			.run(row.id, row.agent, ts);
		return { ...row, runId: Number(runInfo.lastInsertRowid) };
	});
}

/**
 * Fills in what a running job has revealed so far — the pid right after spawn,
 * the session file and id the moment the get_state handshake answers.
 *
 * Its whole purpose is crash-proofing: once the session file is in the row, a
 * daemon SIGKILLed mid-run still leaves a resumable record. COALESCE keeps the
 * earliest capture authoritative when settle later writes the same columns.
 */
export function recordRunStart(
	db: Db,
	runId: number,
	fields: { pid?: number | undefined; sessionFile?: string | undefined; sessionId?: string | undefined },
): void {
	db.prepare(
		`UPDATE runs SET pid          = COALESCE(pid, ?),
		                 session_file = COALESCE(session_file, ?),
		                 session_id   = COALESCE(session_id, ?)
		 WHERE id = ? AND outcome IS NULL`,
	).run(fields.pid ?? null, fields.sessionFile ?? null, fields.sessionId ?? null, runId);
}

export interface FinishInput {
	jobId: number;
	/** The run row opened at claim time; this transaction closes it. */
	runId: number;
	outcome: "succeeded" | "failed" | "interrupted";
	reason?: string | undefined;
	errorSummary?: string | undefined;
	pid?: number | undefined;
	sessionFile?: string | undefined;
	sessionId?: string | undefined;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | undefined;
	/**
	 * Present when the notify policy fires.
	 *
	 * The body may be a function of the run id, kept for callers that want the id
	 * in the message even though the resume hint now carries the session id.
	 */
	notify?: { sink: string; body: string | ((runId: number) => string) } | undefined;
	/** When set, the job returns to pending at this time instead of reaching a terminal state. */
	retryAt?: string | undefined;
}

export interface FinishResult {
	runId: number | null;
	outboxId: number | null;
	/** True when the job was no longer `running`, so someone else already had the verdict. */
	alreadySettled: boolean;
}

/**
 * Terminal transaction: job state, run record and outbox row land together.
 *
 * The notification text is written to outbox here rather than to runs, which is
 * what keeps runs PII-free while still guaranteeing the notification survives a
 * crash — the transactional outbox pattern's whole point.
 */
export function finishJob(db: Db, input: FinishInput): FinishResult {
	return withTransaction(db, () => {
		// `AND state = 'running'` is the whole of the guard: whoever settles a job
		// first owns its verdict.
		//
		// Shutdown is where this bites. A drain that times out marks its lingering
		// jobs `interrupted` and queues the obituaries; the job then finishes a beat
		// later and, ungated, would flip the state back, write a second run row and
		// send a second, contradicting notification for the same job. Measured
		// end to end before this guard existed.
		const changes = input.retryAt
			? db
					.prepare(
						`UPDATE jobs SET state = 'pending', attempts = attempts + 1, reason = ?, scheduled_at = ?
						 WHERE id = ? AND state = 'running'`,
					)
					.run(input.reason ?? null, input.retryAt, input.jobId).changes
			: db
					.prepare(
						`UPDATE jobs SET state = ?, reason = ?, attempts = attempts + 1, finished_at = ?
						 WHERE id = ? AND state = 'running'`,
					)
					.run(input.outcome, input.reason ?? null, nowIso(), input.jobId).changes;

		if (Number(changes) === 0) return { runId: null, outboxId: null, alreadySettled: true };

		// Close the run row the claim opened. COALESCE on pid/session columns: the
		// mid-run recordRunStart capture is the authoritative early write, and the
		// values handed in here are the same facts observed later.
		db.prepare(
			`UPDATE runs SET pid          = COALESCE(pid, ?),
			                 session_file = COALESCE(session_file, ?),
			                 session_id   = COALESCE(session_id, ?),
			                 outcome = ?, reason = ?, error_summary = ?,
			                 input_tokens = ?, output_tokens = ?, cache_read = ?,
			                 cache_write = ?, total_tokens = ?, finished_at = ?
			 WHERE id = ? AND outcome IS NULL`,
		).run(
			input.pid ?? null,
			input.sessionFile ?? null,
			input.sessionId ?? null,
			input.outcome,
			input.reason ?? null,
			input.errorSummary ?? null,
			input.usage?.input ?? null,
			input.usage?.output ?? null,
			input.usage?.cacheRead ?? null,
			input.usage?.cacheWrite ?? null,
			input.usage?.total ?? null,
			nowIso(),
			input.runId,
		);
		const runId = input.runId;

		let outboxId: number | null = null;
		if (input.notify) {
			const body = typeof input.notify.body === "function" ? input.notify.body(runId) : input.notify.body;
			const info = db
				.prepare("INSERT INTO outbox (run_id, sink, body, created_at) VALUES (?, ?, ?, ?)")
				.run(runId, input.notify.sink, body, nowIso());
			outboxId = Number(info.lastInsertRowid);
		}

		return { runId, outboxId, alreadySettled: false };
	});
}

/** What the operator is told about a run whose harness died under it. */
const INTERRUPTED_SUMMARY = "the daemon stopped before this run reached a verdict; its outcome is unknown";

export interface InterruptedResult {
	jobIds: number[];
	/** How many produced an outbox row, i.e. how many the operator will hear about. */
	notified: number;
}

/**
 * Marks jobs left `running` by a dead daemon as interrupted, records a run for
 * each, and queues the notifications their policy asks for.
 *
 * Called at startup and again if a drain does not complete. This is an epistemic
 * state, not a verdict about the work: the harness died, so whether the job
 * succeeded is simply unknown.
 *
 * All three writes belong together. Flipping the state alone was the earlier
 * behaviour and it silently dropped exactly the message the outbox exists to guarantee —
 * an agent killed mid-run notified, but a daemon that died under it did not. It
 * also left `interrupted` unreachable in `runs`, so `pi-reactor runs --dead`
 * could never show one.
 */
export function markInterrupted(db: Db): InterruptedResult {
	// A type alias, not an interface: only the former gets the implicit index
	// signature node:sqlite's Record<string, SQLOutputValue> row type needs.
	type Row = {
		id: number;
		agent: string;
		trigger_id: string | null;
		notify_sink: string | null;
		notify_when: string | null;
		started_at: string | null;
	};
	const rows = db
		.prepare("SELECT id, agent, trigger_id, notify_sink, notify_when, started_at FROM jobs WHERE state = 'running'")
		.all() as Row[];
	if (rows.length === 0) return { jobIds: [], notified: 0 };

	return withTransaction(db, () => {
		const ts = nowIso();
		let notified = 0;
		for (const row of rows) {
			db.prepare("UPDATE jobs SET state = 'interrupted', finished_at = ? WHERE id = ?").run(ts, row.id);

			// Close the run row the claim opened — it may already hold the session
			// file the handshake captured, which is exactly what makes an interrupted
			// run resumable. The INSERT fallback covers a database whose running jobs
			// predate the claim-opens-the-row change.
			const open = db
				.prepare(
					`SELECT id, session_id FROM runs
					 WHERE job_id = ? AND outcome IS NULL ORDER BY id DESC LIMIT 1`,
				)
				.get(row.id) as { id: number; session_id: string | null } | undefined;
			let runId: number;
			let sessionId: string | null = null;
			if (open) {
				db.prepare(
					"UPDATE runs SET outcome = 'interrupted', error_summary = ?, finished_at = ? WHERE id = ?",
				).run(INTERRUPTED_SUMMARY, ts, open.id);
				runId = open.id;
				sessionId = open.session_id;
			} else {
				const runInfo = db
					.prepare(
						`INSERT INTO runs (job_id, agent, outcome, error_summary, started_at, finished_at)
						 VALUES (?, ?, 'interrupted', ?, ?, ?)`,
					)
					.run(row.id, row.agent, INTERRUPTED_SUMMARY, row.started_at ?? ts, ts);
				runId = Number(runInfo.lastInsertRowid);
			}

			// "success" is the one policy that stays silent: an interrupted run is
			// not a success. "failure" and "always" both want to hear about it.
			if (row.notify_sink && row.notify_when !== "success") {
				const label = row.trigger_id ?? `job ${row.id}`;
				// This message is the one that most needs the offer to continue: the
				// harness died mid-conversation, so the transcript is both the record
				// of what happened and the way to pick it up. The handshake capture
				// put the id in the row before the daemon went down — omitting it
				// here would save the data and then hide it.
				const hint = sessionId ? `\n\n↩ pi-reactor resume ${sessionId}` : "";
				db.prepare("INSERT INTO outbox (run_id, sink, body, created_at) VALUES (?, ?, ?, ?)").run(
					runId,
					row.notify_sink,
					`⚠️ ${label} · ${row.agent} · interrupted\n\n${INTERRUPTED_SUMMARY}${hint}`,
					ts,
				);
				notified++;
			}
		}
		return { jobIds: rows.map((r) => r.id), notified };
	});
}

/**
 * The routing of a past job, for `rerun`.
 *
 * Read from `jobs` rather than `runs` because `runs` is deliberately PII-free —
 * it holds no task text, so it cannot describe what to run again.
 */
export interface JobRouting {
	agent: string;
	task: string | null;
	skill: string | null;
	trigger_id: string | null;
	max_duration_s: number;
	require_clean_tree: number;
	retryable: number;
	notify_sink: string | null;
	notify_when: string | null;
}

export function readJobRouting(db: Db, jobId: number): JobRouting | undefined {
	return db
		.prepare(
			`SELECT agent, task, skill, trigger_id, max_duration_s, require_clean_tree,
			        retryable, notify_sink, notify_when
			 FROM jobs WHERE id = ?`,
		)
		.get(jobId) as JobRouting | undefined;
}

// A type alias, not an interface: only the former gets the implicit index
// signature node:sqlite's Record<string, SQLOutputValue> row type needs.
export type LocatedSession = {
	sessionId: string;
	/** Absolute path, exactly as pi reported it at the handshake. */
	sessionFile: string;
	/** Both only for telling candidates apart when a prefix is ambiguous. */
	agent: string;
	startedAt: string;
};

/**
 * Sessions this daemon recorded, by id or unique prefix.
 *
 * Exists because the filesystem is not always the index. `resume` resolves by
 * globbing pi's default session directory, which is right for the common case
 * and needs no daemon — but pi also honours `sessionDir` from its settings
 * (main.js:450-453), and those settings are cwd-bound, so a project-local one
 * puts an agent's transcripts somewhere no fixed glob can find. Rather than
 * replicate pi's resolution chain (and inherit its drift), fall back to the
 * path pi itself reported when the run started.
 *
 * Ordered newest first so an ambiguous prefix lists the likely one first.
 */
export function locateSessions(db: Db, ref: string, limit = 10): LocatedSession[] {
	// substr, not LIKE: SQLite's LIKE folds ASCII case by default, which would
	// make this lookup more permissive than the CLI's own `startsWith` and than
	// pi's (main.js:124). A plain binary compare keeps all three saying the same
	// thing, and needs no wildcard escaping. NULL session_id drops out for free.
	return db
		.prepare(
			`SELECT session_id AS sessionId, session_file AS sessionFile, agent,
			        started_at AS startedAt
			 FROM runs
			 WHERE session_file IS NOT NULL AND substr(session_id, 1, ?) = ?
			 ORDER BY id DESC LIMIT ?`,
		)
		.all(ref.length, ref, limit) as LocatedSession[];
}

/** The job a run belongs to; null for a run whose job has aged out. */
export function jobIdForRun(db: Db, runId: number): number | null {
	const row = db.prepare("SELECT job_id FROM runs WHERE id = ?").get(runId) as { job_id: number | null } | undefined;
	return row?.job_id ?? null;
}

export function insertOutbox(db: Db, sink: string, body: string, runId?: number): number {
	const info = db
		.prepare("INSERT INTO outbox (run_id, sink, body, created_at) VALUES (?, ?, ?, ?)")
		.run(runId ?? null, sink, body, nowIso());
	return Number(info.lastInsertRowid);
}

/** Tokens spent since midnight UTC, the unit the budget gate counts. */
export function tokensSpentToday(db: Db, now: Date = new Date()): number {
	const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
	const row = db
		.prepare("SELECT COALESCE(SUM(total_tokens), 0) AS total FROM runs WHERE started_at >= ?")
		.get(midnight) as { total: number };
	return row.total;
}

/**
 * Live queue depth.
 *
 * No `dead` count: the schema's CHECK constraint permits that job state but
 * nothing writes it — a retry-exhausted job settles as `failed`. Reporting a
 * column that is structurally always zero reads as "nothing is stuck", which is
 * a claim we cannot make. Where things actually go to die is the outbox, and
 * that is what `outboxCounts` surfaces.
 */
export function queueCounts(db: Db): { pending: number; running: number } {
	const rows = db.prepare("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").all() as {
		state: string;
		n: number;
	}[];
	const byState = Object.fromEntries(rows.map((r) => [r.state, r.n]));
	return {
		pending: byState.pending ?? 0,
		running: byState.running ?? 0,
	};
}

/**
 * Outbox depth, including the dead-letter count.
 *
 * Every queue system treats DLQ depth as a first-class signal, and it is the one
 * number that says "a notification you were promised is never coming". It was
 * previously reachable only by opening the database with sqlite3.
 */
export function outboxCounts(db: Db): { pending: number; dead: number } {
	const rows = db.prepare("SELECT state, COUNT(*) AS n FROM outbox GROUP BY state").all() as {
		state: string;
		n: number;
	}[];
	const byState = Object.fromEntries(rows.map((r) => [r.state, r.n]));
	return { pending: byState.pending ?? 0, dead: byState.dead ?? 0 };
}

export function runsToday(db: Db, now: Date = new Date()): number {
	const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
	const row = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?").get(midnight) as { n: number };
	return row.n;
}

export function recentRuns(db: Db, limit = 20, deadOnly = false): unknown[] {
	const where = deadOnly ? "WHERE r.outcome IN ('failed','interrupted')" : "";
	return db
		.prepare(
			`SELECT r.id, r.job_id AS jobId, r.agent, r.outcome, r.reason,
			        r.session_id AS sessionId,
			        r.total_tokens AS totalTokens, r.started_at AS startedAt,
			        r.finished_at AS finishedAt, r.error_summary AS errorSummary
			 FROM runs r ${where}
			 ORDER BY r.id DESC LIMIT ?`,
		)
		.all(limit);
}

// ---------------------------------------------------------------- runtime state

export function getFlag(db: Db, key: string): string | null {
	const row = db.prepare("SELECT value FROM runtime_state WHERE key = ?").get(key) as { value: string } | undefined;
	return row?.value ?? null;
}

/** Durable across restarts, which is the point: a paused daemon comes back paused. */
export function setFlag(db: Db, key: string, value: string): void {
	db.prepare(
		`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	).run(key, value, nowIso());
}

export function isPaused(db: Db): boolean {
	return getFlag(db, "paused") === "1";
}

export { isoSecondsAgo };

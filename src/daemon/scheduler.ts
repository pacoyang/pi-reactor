/**
 * Cron scheduling with explicit misfire policy and a circuit breaker
 *.
 *
 * The scheduler is an internal source of the daemon, not a separate process and
 * emphatically not something living inside the agent loop: waking a main session
 * on a timer to ask "anything to do?" spends a full context window to hear "no".
 *
 * Firing writes the event, the job and the watermark in ONE transaction, and the
 * event id is deterministic — `{triggerId}:{scheduledAt}`. Re-deriving that key
 * for an occurrence already enqueued collides with the unique index instead of
 * double-firing, which is why misfire handling needs no bookkeeping of its own.
 * The same shape Solid Queue uses for recurring tasks, and GoodJob before it.
 */
import { Cron } from "croner";
import type { Db } from "../core/db.ts";
import { nowIso } from "../core/db.ts";
import type { Config, CronTriggerSpec } from "../core/config.ts";
import { cronEvent } from "../core/cloudevents.ts";
import { enqueue } from "./store.ts";
import type { Logger } from "./logger.ts";
import { errorSummary } from "./logger.ts";

/** Consecutive failures before a schedule stops firing. */
export const BREAKER_THRESHOLD = 3;

export interface SchedulerOptions {
	db: Db;
	logger: Logger;
	getConfig: () => Config;
	/** Called when the breaker trips, so the operator hears about it once. */
	onTripped?: (trigger: CronTriggerSpec, reason: string) => void;
}

export interface Scheduler {
	/** Runs misfire recovery, then arms every trigger. */
	start(): void;
	/** Re-arms after a config reload. */
	reload(): void;
	stop(): void;
	/** Records a terminal job outcome against its schedule; drives the breaker. */
	recordOutcome(triggerId: string, succeeded: boolean): void;
}

interface ScheduleRow {
	trigger_id: string;
	last_fired_at: string | null;
	consecutive_failures: number;
	tripped_at: string | null;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
	const { db, logger, getConfig } = options;
	const jobs = new Map<string, Cron>();

	function readSchedule(triggerId: string): ScheduleRow | undefined {
		return db
			.prepare("SELECT trigger_id, last_fired_at, consecutive_failures, tripped_at FROM schedules WHERE trigger_id = ?")
			.get(triggerId) as ScheduleRow | undefined;
	}

	function ensureRow(triggerId: string): ScheduleRow {
		const existing = readSchedule(triggerId);
		if (existing) return existing;
		db.prepare("INSERT INTO schedules (trigger_id, updated_at) VALUES (?, ?)").run(triggerId, nowIso());
		return { trigger_id: triggerId, last_fired_at: null, consecutive_failures: 0, tripped_at: null };
	}

	/**
	 * Enqueues one occurrence and advances the watermark in the same transaction.
	 * A duplicate is not an error: it means this occurrence already landed, which
	 * is exactly what the deterministic id is there to detect.
	 */
	function fire(trigger: CronTriggerSpec, scheduledAt: Date, why: "tick" | "misfire"): void {
		const config = getConfig();
		const agent = config.agents[trigger.run.agent];
		if (!agent) {
			logger.error("cron_agent_missing", { triggerId: trigger.id, agent: trigger.run.agent });
			return;
		}

		try {
			const result = enqueue(db, {
				event: cronEvent(trigger.id, scheduledAt),
				lane: "batch",
				agent: trigger.run.agent,
				task: trigger.run.task,
				skill: trigger.run.skill,
				triggerId: trigger.id,
				maxDurationS: trigger.run.maxDurationS,
				requireCleanTree: trigger.run.requireCleanTree,
				retryable: trigger.run.retryable,
				notify: trigger.notify,
				// In the same transaction, so a crash cannot leave the job enqueued
				// with the watermark still pointing behind it.
				watermark: { triggerId: trigger.id, firedAt: scheduledAt },
			});

			logger[result.duplicate ? "debug" : "info"](result.duplicate ? "cron_duplicate" : "cron_fired", {
				triggerId: trigger.id,
				scheduledAt: scheduledAt.toISOString(),
				jobId: result.jobId,
				why,
			});
		} catch (err) {
			logger.error("cron_fire_failed", { triggerId: trigger.id, error: errorSummary(err) });
		}
	}

	/**
	 * Misfire recovery, run at startup and after a reload.
	 *
	 * Finds the most recent occurrence in `(last_fired_at, now]` and applies the
	 * policy:
	 *   skip      advance the watermark only; a late report is misleading, not useful
	 *   fireOnce  enqueue that occurrence once — never N times, because catching up
	 *             three days of daily reports helps nobody
	 *
	 * A fresh trigger with no watermark is not a misfire: adding a schedule should
	 * not immediately run it.
	 */
	function recoverMisfires(trigger: CronTriggerSpec, now: Date): void {
		const row = ensureRow(trigger.id);
		if (row.tripped_at) {
			logger.warn("cron_tripped_skipped", { triggerId: trigger.id, since: row.tripped_at });
			return;
		}
		if (!row.last_fired_at) {
			db.prepare("UPDATE schedules SET last_fired_at = ?, updated_at = ? WHERE trigger_id = ?")
				.run(now.toISOString(), nowIso(), trigger.id);
			return;
		}

		const since = new Date(row.last_fired_at);
		const latest = latestOccurrence(trigger, since, now);
		if (!latest) return;

		if (trigger.misfirePolicy === "skip") {
			db.prepare("UPDATE schedules SET last_fired_at = ?, updated_at = ? WHERE trigger_id = ?")
				.run(latest.toISOString(), nowIso(), trigger.id);
			logger.info("cron_misfire_skipped", { triggerId: trigger.id, since: row.last_fired_at, upTo: latest.toISOString() });
			return;
		}
		logger.info("cron_misfire_catchup", { triggerId: trigger.id, since: row.last_fired_at, firing: latest.toISOString() });
		fire(trigger, latest, "misfire");
	}

	function arm(trigger: CronTriggerSpec): void {
		const row = ensureRow(trigger.id);
		if (row.tripped_at) return; // stays dark until `schedule resume`; a reload does NOT clear it

		// The occurrence this tick belongs to, held across the callback.
		//
		// NOT `new Date()`. croner fires at a wall clock at or after the scheduled
		// second and strips milliseconds from its own occurrences, so `new Date()`
		// carries jitter — and then the event id `{trigger}:{instant}` stops being
		// re-derivable. Misfire recovery derives `…:00.000Z` while the tick wrote
		// `…:00.003Z`, the unique index sees two different keys, and the occurrence
		// fires twice. Keeping croner's own occurrence is what makes the
		// deterministic-id claim in cloudevents.ts actually true.
		let occurrence: Date | null = null;
		const cron = new Cron(
			trigger.schedule,
			{ ...(trigger.timezone ? { timezone: trigger.timezone } : {}) },
			() => {
				const firing = occurrence ?? new Date();
				occurrence = cron.nextRun();
				fire(trigger, firing, "tick");
			},
		);
		occurrence = cron.nextRun();
		jobs.set(trigger.id, cron);
	}

	function disarmAll(): void {
		for (const cron of jobs.values()) cron.stop();
		jobs.clear();
	}

	function armAll(): void {
		const now = new Date();
		const triggers = getConfig().triggers.filter((t): t is CronTriggerSpec => t.kind === "cron");
		for (const trigger of triggers) {
			recoverMisfires(trigger, now);
			arm(trigger);
		}
		logger.info("scheduler_armed", { count: jobs.size });
	}

	return {
		start: armAll,

		reload() {
			disarmAll();
			armAll();
		},

		stop: disarmAll,

		/**
		 * Breaker bookkeeping.
		 *
		 * Not about bounding spend — the daily cap already does that. The value is
		 * that a broken job would otherwise eat the whole daily budget every day,
		 * starving everything else, and send one identical failure notification a
		 * day until someone notices. Any success resets the count.
		 */
		recordOutcome(triggerId, succeeded) {
			const row = readSchedule(triggerId);
			if (!row) return;

			if (succeeded) {
				if (row.consecutive_failures > 0) {
					db.prepare("UPDATE schedules SET consecutive_failures = 0, updated_at = ? WHERE trigger_id = ?")
						.run(nowIso(), triggerId);
				}
				return;
			}

			const failures = row.consecutive_failures + 1;
			if (failures < BREAKER_THRESHOLD) {
				db.prepare("UPDATE schedules SET consecutive_failures = ?, updated_at = ? WHERE trigger_id = ?")
					.run(failures, nowIso(), triggerId);
				return;
			}

			db.prepare("UPDATE schedules SET consecutive_failures = ?, tripped_at = ?, updated_at = ? WHERE trigger_id = ?")
				.run(failures, nowIso(), nowIso(), triggerId);
			jobs.get(triggerId)?.stop();
			jobs.delete(triggerId);

			const trigger = getConfig().triggers.find(
				(t): t is CronTriggerSpec => t.kind === "cron" && t.id === triggerId,
			);
			logger.warn("cron_breaker_tripped", { triggerId, failures });
			if (trigger) options.onTripped?.(trigger, `${failures} consecutive failures`);
		},
	};
}

/**
 * The most recent occurrence strictly after `from` and at or before `to`, or
 * null when the schedule did not come round in that window.
 *
 * Binary search, not enumeration. `nextRun(t)` returns the first occurrence
 * strictly after `t`, so `nextRun(t) > to` is monotone in `t`: false below the
 * answer, true from the answer onwards. The smallest `t` at which it flips IS
 * the last occurrence in the window, found in ~35 probes for a window of any
 * length.
 *
 * The enumeration this replaces walked forward one occurrence at a time with a
 * cap of 1000 and then returned the 1000th as "the latest". A per-minute
 * schedule after a 17-hour outage therefore caught up to the wrong instant, and
 * `skip` advanced the watermark only part of the way — needing several restarts
 * to converge, while logging `missed: 1000` as though that were the true count.
 */
export function latestOccurrence(trigger: CronTriggerSpec, from: Date, to: Date): Date | null {
	const cron = new Cron(trigger.schedule, {
		...(trigger.timezone ? { timezone: trigger.timezone } : {}),
		paused: true,
	});
	try {
		const first = cron.nextRun(from);
		if (!first || first > to) return null;

		// Invariant: `lo` has an occurrence after it within the window, `hi` does not.
		// `to` never does, because nextRun is strictly greater than its argument.
		let lo = from.getTime();
		let hi = to.getTime();
		while (hi - lo > 1) {
			const mid = Math.floor((lo + hi) / 2);
			const next = cron.nextRun(new Date(mid));
			if (!next || next > to) hi = mid;
			else lo = mid;
		}
		return new Date(hi);
	} finally {
		cron.stop();
	}
}

/** Clears a tripped breaker so the next arm() brings the schedule back. */
export function resumeSchedule(db: Db, triggerId: string): boolean {
	const info = db
		.prepare("UPDATE schedules SET tripped_at = NULL, consecutive_failures = 0, updated_at = ? WHERE trigger_id = ?")
		.run(nowIso(), triggerId);
	return info.changes > 0;
}

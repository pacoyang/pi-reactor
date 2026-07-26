/**
 * Misfire policy, exactly-once enqueue, and the breaker.
 *
 * Time is controlled by passing explicit dates rather than waiting, so these run
 * in milliseconds and assert the boundary arithmetic directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/core/db.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { createScheduler, latestOccurrence, resumeSchedule, BREAKER_THRESHOLD } from "../src/daemon/scheduler.ts";
import { cronEvent } from "../src/core/cloudevents.ts";
import { enqueue } from "../src/daemon/store.ts";
import { parseAgents, parseSinks, parseTriggers, type Config, type CronTriggerSpec } from "../src/core/config.ts";

const quiet = createLogger({ level: "error", write: () => {} });

interface Env {
	db: Db;
	config: Config;
	root: string;
	cleanup(): void;
}

/** Builds a config with one cron trigger, using a real temp cwd so validation passes. */
function env(triggerOverrides: Record<string, unknown> = {}, notify = false): Env {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-sched-"));
	const cwd = join(root, "work");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(root, "placeholder"), "");

	const agents = parseAgents({ agents: { report: { cwd, model: "stub/model" } } }, "a");
	const sinks = parseSinks({ sinks: { tg: { kind: "telegram", chatId: 1 } } }, "s");
	const triggers = parseTriggers(
		{
			triggers: [
				{
					on: { type: "cron", id: "nightly", schedule: "0 9 * * *", timezone: "UTC", misfirePolicy: "skip", ...triggerOverrides },
					run: { agent: "report", task: "summarise" },
					...(notify ? { notify: { sink: "tg", when: "always" } } : {}),
				},
			],
		},
		"t",
		agents,
		sinks,
	);

	return {
		db: openDb(join(root, "state.db")),
		config: { agents, sinks, triggers },
		root,
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

const trigger = (e: Env): CronTriggerSpec => e.config.triggers[0] as CronTriggerSpec;

function setWatermark(db: Db, triggerId: string, at: string): void {
	db.prepare(
		`INSERT INTO schedules (trigger_id, last_fired_at, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(trigger_id) DO UPDATE SET last_fired_at = excluded.last_fired_at`,
	).run(triggerId, at, new Date().toISOString());
}

function jobCount(db: Db): number {
	return (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
}

test("latestOccurrence is exclusive of `from` and inclusive of `to`", () => {
	const e = env();
	try {
		const t = trigger(e);
		// 09:00 UTC daily.
		assert.equal(
			latestOccurrence(t, new Date("2026-07-24T09:00:00Z"), new Date("2026-07-26T09:00:00Z"))?.toISOString(),
			"2026-07-26T09:00:00.000Z",
			"the watermark itself already fired; the last one in the window is what we catch up to",
		);
		assert.equal(
			latestOccurrence(t, new Date("2026-07-26T09:00:00Z"), new Date("2026-07-26T20:00:00Z")),
			null,
			"no occurrence between today's fire and tonight",
		);
		assert.equal(
			latestOccurrence(t, new Date("2026-07-25T09:00:00Z"), new Date("2026-07-26T09:00:00.000Z"))?.toISOString(),
			"2026-07-26T09:00:00.000Z",
			"an occurrence landing exactly on `to` is inside the window",
		);
	} finally {
		e.cleanup();
	}
});

test("latestOccurrence stays exact across a window with far more than 1000 occurrences", () => {
	const e = env({ schedule: "* * * * *" });
	try {
		// A per-minute schedule over 30 days is ~43200 occurrences. The enumeration
		// this replaced capped at 1000 and returned the 1000th as "the latest", so
		// `skip` advanced the watermark 16 hours instead of 30 days and `fireOnce`
		// caught up to a month-old instant.
		const got = latestOccurrence(
			trigger(e),
			new Date("2026-06-26T00:00:00Z"),
			new Date("2026-07-26T12:34:56.789Z"),
		);
		assert.equal(got?.toISOString(), "2026-07-26T12:34:00.000Z");
	} finally {
		e.cleanup();
	}
});

test("misfire skip: advances the watermark and enqueues nothing", () => {
	const e = env({ misfirePolicy: "skip" });
	try {
		setWatermark(e.db, "nightly", "2026-07-23T09:00:00.000Z");
		const scheduler = createScheduler({ db: e.db, logger: quiet, getConfig: () => e.config });

		// Pretend "now" is three days later by arming when the clock has moved on.
		// start() uses the real clock, so we exercise recoverMisfires through it and
		// assert on the outcome rather than the internal call.
		scheduler.start();
		scheduler.stop();

		assert.equal(jobCount(e.db), 0, "a late daily report is misleading, not useful");
		const row = e.db.prepare("SELECT last_fired_at FROM schedules WHERE trigger_id = 'nightly'").get() as {
			last_fired_at: string;
		};
		assert.ok(
			row.last_fired_at > "2026-07-23T09:00:00.000Z",
			"the watermark still advances, so the same window is not reconsidered forever",
		);
	} finally {
		e.cleanup();
	}
});

test("misfire fireOnce: catches up exactly once, never once per missed occurrence", () => {
	const e = env({ misfirePolicy: "fireOnce" });
	try {
		// Three days behind: three occurrences were missed.
		setWatermark(e.db, "nightly", "2026-07-20T09:00:00.000Z");
		const scheduler = createScheduler({ db: e.db, logger: quiet, getConfig: () => e.config });
		scheduler.start();
		scheduler.stop();

		assert.equal(jobCount(e.db), 1, "catching up three days of daily reports helps nobody");
	} finally {
		e.cleanup();
	}
});

test("a brand new trigger does not fire on arm", () => {
	const e = env({ misfirePolicy: "fireOnce" });
	try {
		const scheduler = createScheduler({ db: e.db, logger: quiet, getConfig: () => e.config });
		scheduler.start();
		scheduler.stop();

		assert.equal(jobCount(e.db), 0, "adding a schedule must not immediately run it");
		const row = e.db.prepare("SELECT last_fired_at FROM schedules WHERE trigger_id = 'nightly'").get() as {
			last_fired_at: string | null;
		};
		assert.ok(row.last_fired_at, "the watermark is seeded to now so the next start sees no backlog");
	} finally {
		e.cleanup();
	}
});

test("restarting twice does not replay: the deterministic id collides", () => {
	const e = env({ misfirePolicy: "fireOnce" });
	try {
		setWatermark(e.db, "nightly", "2026-07-20T09:00:00.000Z");

		const first = createScheduler({ db: e.db, logger: quiet, getConfig: () => e.config });
		first.start();
		first.stop();
		const afterFirst = jobCount(e.db);

		// Rewind the watermark as if the second start saw the same backlog.
		setWatermark(e.db, "nightly", "2026-07-20T09:00:00.000Z");
		const second = createScheduler({ db: e.db, logger: quiet, getConfig: () => e.config });
		second.start();
		second.stop();

		assert.equal(afterFirst, 1);
		assert.equal(jobCount(e.db), 1,
			"the same occurrence yields the same (source,id), so the unique index absorbs the replay");
	} finally {
		e.cleanup();
	}
});

test("a cron event's id is derived from the occurrence, not the wall clock", () => {
	const at = new Date("2026-07-27T09:00:00.000Z");
	const a = cronEvent("nightly", at);
	const b = cronEvent("nightly", at);
	assert.equal(a.id, b.id, "re-deriving the key must be stable, that is what makes dedup work");
	assert.equal(a.source, "cron:nightly");
	assert.notEqual(cronEvent("nightly", new Date("2026-07-28T09:00:00.000Z")).id, a.id);
});

test("a live tick fires on croner's occurrence, so misfire recovery re-derives the same key", async () => {
	// The regression: the tick used to pass `new Date()`, which carries the
	// milliseconds croner strips from its own occurrences. Misfire recovery then
	// derived `…:00.000Z` while the tick had written `…:00.003Z` — two different
	// event ids for one occurrence, so the unique index saw nothing to dedup and
	// the schedule fired twice, spending twice.
	const e = env({ schedule: "* * * * * *" }); // every second, so a real tick lands
	try {
		const scheduler = createScheduler({ db: e.db, logger: quiet, getConfig: () => e.config });
		scheduler.start();
		await new Promise((r) => setTimeout(r, 1600));
		scheduler.stop();

		const ids = e.db.prepare("SELECT ce_id FROM events ORDER BY seq").all() as { ce_id: string }[];
		assert.ok(ids.length >= 1, "at least one tick should have landed");
		for (const { ce_id } of ids) {
			const instant = ce_id.slice("nightly:".length);
			assert.match(instant, /T\d\d:\d\d:\d\d\.000Z$/,
				`${ce_id} carries wall-clock jitter; misfire recovery could never re-derive it`);
		}

		// And the watermark agrees with the id, which is what lets recovery decide.
		const row = e.db.prepare("SELECT last_fired_at FROM schedules WHERE trigger_id = 'nightly'").get() as {
			last_fired_at: string;
		};
		assert.equal(`nightly:${row.last_fired_at}`, ids[ids.length - 1]?.ce_id);
	} finally {
		e.cleanup();
	}
});

test("breaker trips after three consecutive failures and stops firing", () => {
	const e = env({}, true);
	try {
		const tripped: string[] = [];
		const scheduler = createScheduler({
			db: e.db,
			logger: quiet,
			getConfig: () => e.config,
			onTripped: (t, reason) => tripped.push(`${t.id}:${reason}`),
		});
		scheduler.start();

		for (let i = 0; i < BREAKER_THRESHOLD - 1; i++) {
			scheduler.recordOutcome("nightly", false);
		}
		const before = e.db.prepare("SELECT tripped_at, consecutive_failures FROM schedules WHERE trigger_id='nightly'").get() as {
			tripped_at: string | null; consecutive_failures: number;
		};
		assert.equal(before.tripped_at, null, `still armed at ${BREAKER_THRESHOLD - 1} failures`);
		assert.equal(before.consecutive_failures, BREAKER_THRESHOLD - 1);

		scheduler.recordOutcome("nightly", false);
		const after = e.db.prepare("SELECT tripped_at FROM schedules WHERE trigger_id='nightly'").get() as {
			tripped_at: string | null;
		};
		assert.ok(after.tripped_at, "a broken job would otherwise eat the daily budget every day");
		assert.equal(tripped.length, 1, "the operator hears about it once, not once per fire");
		scheduler.stop();
	} finally {
		e.cleanup();
	}
});

test("any success resets the failure count", () => {
	const e = env();
	try {
		const scheduler = createScheduler({ db: e.db, logger: quiet, getConfig: () => e.config });
		scheduler.start();
		scheduler.recordOutcome("nightly", false);
		scheduler.recordOutcome("nightly", false);
		scheduler.recordOutcome("nightly", true);

		const row = e.db.prepare("SELECT consecutive_failures, tripped_at FROM schedules WHERE trigger_id='nightly'").get() as {
			consecutive_failures: number; tripped_at: string | null;
		};
		assert.equal(row.consecutive_failures, 0);
		assert.equal(row.tripped_at, null);

		scheduler.recordOutcome("nightly", false);
		scheduler.recordOutcome("nightly", false);
		const still = e.db.prepare("SELECT tripped_at FROM schedules WHERE trigger_id='nightly'").get() as {
			tripped_at: string | null;
		};
		assert.equal(still.tripped_at, null, "the window is consecutive failures, not lifetime failures");
		scheduler.stop();
	} finally {
		e.cleanup();
	}
});

test("a tripped schedule stays dark across a restart until resumed", () => {
	const e = env({ misfirePolicy: "fireOnce" });
	try {
		setWatermark(e.db, "nightly", "2026-07-20T09:00:00.000Z");
		e.db.prepare("UPDATE schedules SET tripped_at = ? WHERE trigger_id = 'nightly'").run(new Date().toISOString());

		const scheduler = createScheduler({ db: e.db, logger: quiet, getConfig: () => e.config });
		scheduler.start();
		scheduler.stop();
		assert.equal(jobCount(e.db), 0, "a tripped schedule must not catch up on restart either");

		assert.equal(resumeSchedule(e.db, "nightly"), true);
		const after = e.db.prepare("SELECT tripped_at, consecutive_failures FROM schedules WHERE trigger_id='nightly'").get() as {
			tripped_at: string | null; consecutive_failures: number;
		};
		assert.equal(after.tripped_at, null);
		assert.equal(after.consecutive_failures, 0);
		assert.equal(resumeSchedule(e.db, "no-such-trigger"), false);
	} finally {
		e.cleanup();
	}
});

test("firing writes event, job and watermark together", () => {
	const e = env({ misfirePolicy: "fireOnce" });
	try {
		setWatermark(e.db, "nightly", "2026-07-20T09:00:00.000Z");
		const scheduler = createScheduler({ db: e.db, logger: quiet, getConfig: () => e.config });
		scheduler.start();
		scheduler.stop();

		const job = e.db
			.prepare("SELECT trigger_id, agent, task, notify_sink FROM jobs LIMIT 1")
			.get() as { trigger_id: string; agent: string; task: string; notify_sink: string | null };
		assert.equal(job.trigger_id, "nightly", "the job points back at its schedule so the breaker can count it");
		assert.equal(job.agent, "report");
		assert.equal(job.task, "summarise");

		const event = e.db.prepare("SELECT ce_source, ce_type FROM events LIMIT 1").get() as {
			ce_source: string; ce_type: string;
		};
		assert.equal(event.ce_source, "cron:nightly");
		assert.equal(event.ce_type, "dev.pi-reactor.cron.fired");

		const row = e.db.prepare("SELECT last_fired_at FROM schedules WHERE trigger_id='nightly'").get() as {
			last_fired_at: string;
		};
		const eventId = (e.db.prepare("SELECT ce_id FROM events LIMIT 1").get() as { ce_id: string }).ce_id;
		assert.equal(row.last_fired_at, eventId.slice("nightly:".length),
			"the watermark records the OCCURRENCE that fired, which is also the event id");
		assert.ok(new Date(row.last_fired_at) <= new Date(), "an occurrence in the future was never missed");
		assert.match(row.last_fired_at, /T09:00:00\.000Z$/, "and it lands on the schedule's 09:00 UTC boundary");
	} finally {
		e.cleanup();
	}
});

test("a duplicate enqueue leaves the queue untouched", () => {
	const e = env();
	try {
		const at = new Date("2026-07-27T09:00:00Z");
		const base = {
			lane: "batch" as const, agent: "report", task: "t",
			maxDurationS: 60, requireCleanTree: false, retryable: true,
		};
		const first = enqueue(e.db, { ...base, event: cronEvent("nightly", at) });
		const second = enqueue(e.db, { ...base, event: cronEvent("nightly", at) });

		assert.equal(first.duplicate, false);
		assert.equal(second.duplicate, true);
		assert.equal(second.seq, first.seq);
		assert.equal(jobCount(e.db), 1);
	} finally {
		e.cleanup();
	}
});

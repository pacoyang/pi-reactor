import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, migrate, userVersion, nowIso, isoSecondsAgo, type Db } from "../src/core/db.ts";
import { MIGRATIONS } from "../src/core/migrations.ts";

function withDb(fn: (db: Db, dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-reactor-test-"));
	const db = openDb(join(dir, "state.db"));
	try {
		fn(db, dir);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("migrate: creates tables and advances user_version", () => {
	withDb((db) => {
		assert.equal(userVersion(db), MIGRATIONS.length);
		const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
			.map((r) => r.name)
			.filter((n) => !n.startsWith("sqlite_"));
		assert.deepEqual(tables, ["events", "jobs", "outbox", "runs", "runtime_state", "schedules"]);
	});
});

test("migrate v1->v2: existing rows survive, the new column is NULL", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-reactor-test-"));
	try {
		// A database as v1 left it: only the first migration applied.
		const path = join(dir, "state.db");
		const v1 = new DatabaseSync(path);
		v1.exec("PRAGMA journal_mode = WAL");
		v1.exec(MIGRATIONS[0] as string);
		v1.exec("PRAGMA user_version = 1");
		v1.prepare("INSERT INTO runs (agent, outcome, started_at) VALUES ('nightly', 'succeeded', ?)").run(nowIso());
		v1.close();

		const db = openDb(path);
		try {
			assert.equal(userVersion(db), MIGRATIONS.length);
			const row = db.prepare("SELECT agent, outcome, session_id FROM runs").get() as {
				agent: string; outcome: string; session_id: string | null;
			};
			assert.equal(row.agent, "nightly");
			assert.equal(row.outcome, "succeeded");
			assert.equal(row.session_id, null, "a run recorded before the column simply has no session to resume");
		} finally {
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("migrate: idempotent, running twice leaves user_version untouched", () => {
	withDb((db) => {
		const before = userVersion(db);
		migrate(db);
		migrate(db);
		assert.equal(userVersion(db), before);
	});
});

test("events: (ce_source, ce_id) is unique, the basis of exactly-once enqueue", () => {
	withDb((db) => {
		const insert = db.prepare(
			"INSERT INTO events (ce_id, ce_source, ce_type, lane, data, received_at) VALUES (?, ?, ?, ?, ?, ?)",
		);
		insert.run("nightly:2026-07-27T09:00:00+08:00", "cron:nightly", "dev.pi-reactor.cron.fired", "batch", "{}", nowIso());
		assert.throws(
			() => insert.run("nightly:2026-07-27T09:00:00+08:00", "cron:nightly", "dev.pi-reactor.cron.fired", "batch", "{}", nowIso()),
			/UNIQUE/i,
			"a repeated (source,id) must hit the unique index: misfire catch-up and webhook redelivery both rely on it",
		);
		// The same id under a different source is a different event.
		insert.run("nightly:2026-07-27T09:00:00+08:00", "cron:other", "dev.pi-reactor.cron.fired", "batch", "{}", nowIso());
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 2);
	});
});

test("jobs: CHECK constraints reject values outside the state and lane vocabularies", () => {
	withDb((db) => {
		db.prepare("INSERT INTO events (ce_id, ce_source, ce_type, lane, data, received_at) VALUES (?,?,?,?,?,?)")
			.run("e1", "cli", "t", "batch", "{}", nowIso());
		const insertJob = db.prepare("INSERT INTO jobs (event_seq, agent, state, created_at) VALUES (1, 'a', ?, ?)");
		insertJob.run("pending", nowIso());
		assert.throws(() => insertJob.run("timed_out", nowIso()), /CHECK/i,
			"timed_out was withdrawn in v0.4.1; express it as failed + reason:timeout");
		assert.throws(
			() => db.prepare("INSERT INTO events (ce_id, ce_source, ce_type, lane, data, received_at) VALUES (?,?,?,?,?,?)")
				.run("e2", "cli", "t", "control", "{}", nowIso()),
			/CHECK/i,
			"the control lane was removed in v0.8: admin commands are JSON-RPC methods, not events",
		);
	});
});

test("jobs cascade from events, so the reaper only has to delete events", () => {
	withDb((db) => {
		db.prepare("INSERT INTO events (ce_id, ce_source, ce_type, lane, data, received_at) VALUES (?,?,?,?,?,?)")
			.run("e1", "cli", "t", "batch", "{}", nowIso());
		db.prepare("INSERT INTO jobs (event_seq, agent, created_at) VALUES (1, 'a', ?)").run(nowIso());
		db.exec("DELETE FROM events WHERE seq = 1");
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 0);
	});
});

test("isoSecondsAgo drives the age-based cleanup boundary", () => {
	const from = new Date("2026-07-27T00:00:00.000Z");
	assert.equal(isoSecondsAgo(86400, from), "2026-07-26T00:00:00.000Z");
	assert.ok(isoSecondsAgo(30 * 86400, from) < from.toISOString(), "ISO string order equals chronological order");
});

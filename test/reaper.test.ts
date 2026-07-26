/**
 * Reaper behaviour: what gets reclaimed, what is deliberately spared, and the
 * ordering that makes session cleanup possible at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/core/db.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { reap, DEFAULT_RETENTION_DAYS } from "../src/daemon/reaper.ts";
import { cliEvent } from "../src/core/cloudevents.ts";
import { enqueue, insertOutbox } from "../src/daemon/store.ts";

const quiet = createLogger({ level: "error", write: () => {} });

function withDb(fn: (db: Db, root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-reap-"));
	const db = openDb(join(root, "state.db"));
	try {
		fn(db, root);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
}

function daysAgo(n: number): string {
	return new Date(Date.now() - n * 86400 * 1000).toISOString();
}

/** Inserts a run row directly, so its age can be controlled. */
function seedRun(db: Db, startedAt: string, sessionFile?: string): number {
	const info = db
		.prepare("INSERT INTO runs (agent, outcome, session_file, started_at, total_tokens) VALUES ('a','succeeded',?,?,10)")
		.run(sessionFile ?? null, startedAt);
	return Number(info.lastInsertRowid);
}

test("aged rows are deleted and recent ones are kept", () => {
	withDb((db) => {
		seedRun(db, daysAgo(DEFAULT_RETENTION_DAYS + 5));
		seedRun(db, daysAgo(1));

		const result = reap({ db, logger: quiet, listOrphans: () => [] });

		assert.equal(result.runs, 1);
		const left = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
		assert.equal(left.n, 1, "yesterday's run is still history worth having");
	});
});

test("jobs disappear with their events rather than needing their own delete", () => {
	withDb((db) => {
		enqueue(db, {
			event: cliEvent("old-one"), lane: "batch", agent: "a", task: "t",
			maxDurationS: 60, requireCleanTree: false, retryable: true,
		});
		db.prepare("UPDATE events SET received_at = ?").run(daysAgo(DEFAULT_RETENTION_DAYS + 1));

		reap({ db, logger: quiet, listOrphans: () => [] });

		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0);
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 0,
			"the ON DELETE CASCADE means the reaper only has to think about events");
	});
});

test("a pending outbox row is spared no matter how old", () => {
	withDb((db) => {
		const pending = insertOutbox(db, "tg", "still owed");
		const sent = insertOutbox(db, "tg", "already delivered");
		db.prepare("UPDATE outbox SET created_at = ? WHERE id IN (?, ?)")
			.run(daysAgo(DEFAULT_RETENTION_DAYS + 10), pending, sent);
		db.prepare("UPDATE outbox SET state = 'sent' WHERE id = ?").run(sent);

		const result = reap({ db, logger: quiet, listOrphans: () => [] });

		assert.equal(result.outbox, 1);
		const row = db.prepare("SELECT state FROM outbox WHERE id = ?").get(pending) as { state: string } | undefined;
		assert.equal(row?.state, "pending",
			"an undelivered notification is still owed to the operator regardless of age");
	});
});

test("only session files WE recorded are deleted", () => {
	withDb((db, root) => {
		const ours = join(root, "ours.jsonl");
		const theirs = join(root, "operator-session.jsonl");
		writeFileSync(ours, "{}");
		writeFileSync(theirs, "{}");

		seedRun(db, daysAgo(DEFAULT_RETENTION_DAYS + 1), ours);

		const result = reap({ db, logger: quiet, listOrphans: () => [] });

		assert.equal(result.sessionFiles, 1);
		assert.equal(existsSync(ours), false);
		assert.equal(existsSync(theirs), true,
			"pi's directory holds the operator's own sessions; those are not ours to delete");
	});
});

test("a recent run's session file survives", () => {
	withDb((db, root) => {
		const recent = join(root, "recent.jsonl");
		writeFileSync(recent, "{}");
		seedRun(db, daysAgo(1), recent);

		reap({ db, logger: quiet, listOrphans: () => [] });
		assert.equal(existsSync(recent), true);
	});
});

test("session files are collected before the rows naming them are deleted", () => {
	withDb((db, root) => {
		// If the ordering were reversed, the paths would be gone before we could
		// read them and the files would leak forever.
		const file = join(root, "ordering.jsonl");
		writeFileSync(file, "{}");
		seedRun(db, daysAgo(DEFAULT_RETENTION_DAYS + 1), file);

		const result = reap({ db, logger: quiet, listOrphans: () => [] });

		assert.equal(result.sessionFiles, 1, "the path must be read while its run row still exists");
		assert.equal(result.runs, 1);
	});
});

test("a missing session file is not an error", () => {
	withDb((db, root) => {
		seedRun(db, daysAgo(DEFAULT_RETENTION_DAYS + 1), join(root, "already-gone.jsonl"));
		const result = reap({ db, logger: quiet, listOrphans: () => [] });
		assert.equal(result.sessionFiles, 0);
		assert.equal(result.runs, 1, "cleanup continues past a file someone else already removed");
	});
});

test("an unlink failure does not abort the reap", () => {
	withDb((db, root) => {
		const file = join(root, "locked.jsonl");
		writeFileSync(file, "{}");
		seedRun(db, daysAgo(DEFAULT_RETENTION_DAYS + 1), file);

		const result = reap({
			db, logger: quiet, listOrphans: () => [],
			unlink: () => { throw new Error("EPERM"); },
		});

		assert.equal(result.sessionFiles, 0);
		assert.equal(result.runs, 1, "a reaper that throws would stop the daemon starting, which is far worse");
	});
});

test("orphaned agent processes are killed, and the kill list is honoured exactly", () => {
	withDb((db) => {
		const killed: number[] = [];
		const result = reap({
			db, logger: quiet,
			listOrphans: () => [4242, 4243],
			killOrphan: (pid) => killed.push(pid),
		});

		assert.deepEqual(killed, [4242, 4243], "a leaked agent keeps spending, so it goes before work resumes");
		assert.equal(result.orphans, 2);
	});
});

test("a kill that fails is logged rather than fatal", () => {
	withDb((db) => {
		const result = reap({
			db, logger: quiet,
			listOrphans: () => [1, 2],
			killOrphan: (pid) => { if (pid === 1) throw new Error("ESRCH"); },
		});
		assert.equal(result.orphans, 1, "one failure must not skip the rest");
	});
});

test("retentionDays is respected", () => {
	withDb((db) => {
		seedRun(db, daysAgo(5));
		assert.equal(reap({ db, logger: quiet, retentionDays: 30, listOrphans: () => [] }).runs, 0);
		assert.equal(reap({ db, logger: quiet, retentionDays: 1, listOrphans: () => [] }).runs, 1);
	});
});

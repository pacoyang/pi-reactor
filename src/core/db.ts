/**
 * SQLite connection and migration execution.
 *
 * Uses `node:sqlite` (built into Node 24, zero native dependencies — avoids the
 * ARM/musl/glibc build surface). Swapping in better-sqlite3 means changing only
 * this file: everything else depends on the `Db` type below.
 *
 * The daemon is the sole writer (every source arrives through the socket), so the
 * single-writer model holds and claiming a job needs only `BEGIN IMMEDIATE`.
 */
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type Db = DatabaseSync;

export class MigrationError extends Error {
	override readonly name = "MigrationError";
}

export function openDb(file: string): Db {
	const db = new DatabaseSync(file);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		PRAGMA synchronous = NORMAL;
		PRAGMA auto_vacuum = INCREMENTAL;
	`);
	migrate(db);
	return db;
}

/**
 * Applies pending migrations in order, tracked by `PRAGMA user_version`.
 * A failure rolls that migration back and throws: the daemon refuses to start
 * rather than run on a half-applied schema. Idempotent — a no-op once current.
 */
export function migrate(db: Db): void {
	const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
	const current = row?.user_version ?? 0;

	for (let i = current; i < MIGRATIONS.length; i++) {
		const sql = MIGRATIONS[i];
		if (sql === undefined) {
			// Unreachable given the loop bound; throwing beats silently skipping a
			// migration and leaving user_version ahead of the applied schema.
			throw new MigrationError(`migration ${i + 1} is missing from the MIGRATIONS array`);
		}
		try {
			withTransaction(db, () => {
				db.exec(sql);
				// user_version does not accept bound parameters; `i` is a loop index,
				// never external input.
				db.exec(`PRAGMA user_version = ${i + 1}`);
			});
		} catch (cause) {
			throw new MigrationError(
				`migration ${i + 1} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
		}
	}
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE`, committing on return and rolling back on
 * throw.
 *
 * A helper rather than hand-written begin/commit/rollback at each call site: the
 * failure mode of the manual form is a missed ROLLBACK, which leaves the
 * connection in a transaction and turns the next unrelated write into a mystery.
 * better-sqlite3 exposes the same shape as `db.transaction(fn)`; node:sqlite has
 * no equivalent, so this is it.
 *
 * `IMMEDIATE` rather than the default deferred: the daemon is the sole writer, so
 * taking the write lock up front is the whole of the concurrency control.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (err) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// A COMMIT that fails may have rolled back already, in which case this
			// throws "no transaction is active" — and that error would replace the
			// real one on its way out. The caller needs the cause, not the cleanup.
		}
		throw err;
	}
}

export function userVersion(db: Db): number {
	const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
	return row?.user_version ?? 0;
}

/**
 * RFC3339 with millisecond precision, UTC. Every time column uses this so that
 * string comparison is time comparison.
 */
export function nowIso(): string {
	return new Date().toISOString();
}

/** ISO timestamp for `now - seconds`; used by age-based cleanup and backoff. */
export function isoSecondsAgo(seconds: number, from: Date = new Date()): string {
	return new Date(from.getTime() - seconds * 1000).toISOString();
}

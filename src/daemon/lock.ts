/**
 * Daemon singleton.
 *
 * O_EXCL create plus a liveness probe, NOT flock: Node has no `fs.flock` and no
 * `LOCK_*` constants (verified). The three options were `proper-lockfile`
 * (mkdir + mtime staleness), O_EXCL with a pid probe, and a native binding —
 * the last of which would break the zero-build promise. We take the second:
 * no dependency, sufficient for one machine and one user, and structurally the
 * same thing pi-telegram does (owners.json records pid/cwd and takes over stale
 * entries; it also probes rather than locking).
 *
 * Known residual: a recycled PID belonging to an unrelated process reads as
 * "alive" and blocks startup. Vanishingly unlikely on a personal machine, and
 * the failure direction is safe — refusing to start rather than running twice.
 *
 * Two daemons would mean two writers on SQLite and two schedulers, which
 * defeats misfire catch-up and every concurrency gate at once.
 */
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync } from "node:fs";

export class LockError extends Error {
	override readonly name = "LockError";
	readonly holder: LockRecord | undefined;
	constructor(message: string, holder?: LockRecord) {
		super(message);
		this.holder = holder;
	}
}

export interface LockRecord {
	pid: number;
	startedAt: string;
}

/** Signal 0 tests for existence. EPERM means alive but owned by another user. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readLock(file: string): LockRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LockRecord>;
		if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
		return { pid: parsed.pid, startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown" };
	} catch {
		return null;
	}
}

export interface AcquiredLock {
	/** Removes the lock file, but only if we still own it. */
	release(): void;
}

/**
 * Takes the lock or throws `LockError` naming the holder.
 *
 * A malformed or stale file is removed and the create retried once. O_EXCL is
 * the arbitration point between two daemons racing to start: exactly one create
 * succeeds, the loser gets EEXIST.
 */
export function acquireLock(file: string, pid: number = process.pid): AcquiredLock {
	const existing = readLock(file);
	if (existing) {
		if (isAlive(existing.pid)) {
			throw new LockError(
				`another pi-reactor daemon is running (pid ${existing.pid}, since ${existing.startedAt})`,
				existing,
			);
		}
		unlinkSync(file); // stale: the recorded process is gone
	} else if (existsSync(file)) {
		unlinkSync(file); // unparseable leftover
	}

	let fd: number;
	try {
		fd = openSync(file, "wx", 0o600);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			throw new LockError("lost the race for the pi-reactor lock", readLock(file) ?? undefined);
		}
		throw err;
	}

	const record: LockRecord = { pid, startedAt: new Date().toISOString() };
	try {
		writeSync(fd, JSON.stringify(record));
	} finally {
		closeSync(fd);
	}

	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			// Only delete our own lock: a successor may already hold this path.
			if (readLock(file)?.pid === pid) {
				try {
					unlinkSync(file);
				} catch {
					// Nothing useful to do while shutting down.
				}
			}
		},
	};
}

/**
 * Boot-time reclamation of everything a previous run left behind
 *.
 *
 * Three kinds of debris, one trigger point, one retention knob — which is why
 * they live together rather than being scattered into the modules that own each
 * artifact. pi-dispatch splits its reapers (containers in start.mjs, logs in
 * run-history.mjs) because those two share no configuration; ours share both
 * `retentionDays` and "runs once at startup".
 *
 *   1. aged database rows
 *   2. pi session files WE created — never anything else in pi's directory
 *   3. orphaned `pi --mode rpc` children of a daemon that died
 *
 * Every step is best-effort: a reaper that throws would keep the daemon from
 * starting, which is a far worse outcome than some debris surviving another day.
 */
import { existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Db } from "../core/db.ts";
import { isoSecondsAgo, withTransaction } from "../core/db.ts";
import type { Logger } from "./logger.ts";
import { errorSummary } from "./logger.ts";

export const DEFAULT_RETENTION_DAYS = 30;

export interface ReapResult {
	events: number;
	runs: number;
	outbox: number;
	sessionFiles: number;
	orphans: number;
}

export interface ReapOptions {
	db: Db;
	logger: Logger;
	retentionDays?: number;
	/** Injected for tests. */
	now?: Date;
	unlink?: (path: string) => void;
	fileExists?: (path: string) => boolean;
	listOrphans?: () => number[];
	killOrphan?: (pid: number) => void;
}

/**
 * Deletes aged rows and the session files they reference.
 *
 * Order matters: session paths must be read BEFORE the run rows are deleted,
 * otherwise the only record of which files are ours disappears with them.
 * `jobs` needs no explicit delete — it cascades from `events`.
 */
export function reap(options: ReapOptions): ReapResult {
	const { db, logger } = options;
	const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
	const now = options.now ?? new Date();
	const cutoff = isoSecondsAgo(retentionDays * 86400, now);
	const unlink = options.unlink ?? ((p: string) => unlinkSync(p));
	const exists = options.fileExists ?? ((p: string) => existsSync(p));

	const result: ReapResult = { events: 0, runs: 0, outbox: 0, sessionFiles: 0, orphans: 0 };

	try {
		// 1. Session files first, while the rows that name them still exist.
		//    Only paths recorded in OUR runs table are touched: pi's directory
		//    holds sessions from the operator's own work, and those are not ours
		//    to delete.
		const doomed = db
			.prepare("SELECT DISTINCT session_file FROM runs WHERE started_at < ? AND session_file IS NOT NULL")
			.all(cutoff) as { session_file: string }[];
		for (const row of doomed) {
			try {
				if (exists(row.session_file)) {
					unlink(row.session_file);
					result.sessionFiles++;
				}
			} catch (err) {
				logger.debug("reap_session_failed", { file: row.session_file, error: errorSummary(err) });
			}
		}

		withTransaction(db, () => {
			result.runs = Number(db.prepare("DELETE FROM runs WHERE started_at < ?").run(cutoff).changes);
			// Only settled outbox rows: a pending one is still owed to the operator
			// regardless of age.
			result.outbox = Number(
				db.prepare("DELETE FROM outbox WHERE state IN ('sent','dead') AND created_at < ?").run(cutoff).changes,
			);
			result.events = Number(db.prepare("DELETE FROM events WHERE received_at < ?").run(cutoff).changes);
		});

		// Return freed pages to the filesystem; auto_vacuum = INCREMENTAL makes
		// this cheap and incremental rather than a full rebuild.
		db.exec("PRAGMA incremental_vacuum");
		// Refresh the query planner's statistics now that a large delete has changed
		// the shape of every table. SQLite's own recommendation for a long-lived
		// connection, and startup is the moment where the cost is invisible.
		db.exec("PRAGMA optimize");
	} catch (err) {
		logger.error("reap_rows_failed", { error: errorSummary(err) });
	}

	// 2. Orphaned agent processes. A leaked one keeps spending, so it has to go
	//    before the worker starts claiming new work.
	try {
		const orphans = (options.listOrphans ?? findOrphanAgents)();
		const kill = options.killOrphan ?? ((pid: number) => process.kill(pid, "SIGKILL"));
		for (const pid of orphans) {
			try {
				kill(pid);
				result.orphans++;
			} catch (err) {
				logger.debug("reap_orphan_failed", { pid, error: errorSummary(err) });
			}
		}
	} catch (err) {
		logger.debug("reap_orphans_failed", { error: errorSummary(err) });
	}

	const total = result.events + result.runs + result.outbox + result.sessionFiles + result.orphans;
	if (total > 0) logger.info("reaped", { ...result, retentionDays });
	return result;
}

/**
 * Finds `pi --mode rpc` processes that are not our children.
 *
 * Matches on the rpc-entry path, which only this daemon and pi itself spawn.
 * Anything whose parent is still alive belongs to someone else — most likely an
 * operator running pi by hand — and is left completely alone.
 */
export function findOrphanAgents(): number[] {
	let output: string;
	try {
		output = execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return []; // no ps, or not permitted: skip rather than guess
	}

	const orphans: number[] = [];
	for (const line of output.split("\n")) {
		if (!line.includes("rpc-entry")) continue;
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const ppid = Number(match[2]);
		if (pid === process.pid || ppid === process.pid) continue;
		// ppid 1 means the parent is gone and init adopted it: a true orphan.
		if (ppid === 1) orphans.push(pid);
	}
	return orphans;
}

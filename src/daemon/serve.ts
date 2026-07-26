/**
 * Daemon startup and shutdown orchestration.
 *
 * Startup order matters and is asserted by the integration test:
 *   lock -> open+migrate db -> mark interrupted -> load config -> listen -> work
 *
 * The lock comes first because everything after it assumes exclusive ownership
 * of the directory: removing a stale socket file, writing to SQLite, and
 * rewriting `running` rows are all unsafe if a second daemon is alive.
 */
import { loadConfig, ConfigError, type Config } from "../core/config.ts";
import { openDb, nowIso, type Db } from "../core/db.ts";
import { ensureDirs, type Paths } from "../core/paths.ts";
import { acquireLock, LockError, type AcquiredLock } from "./lock.ts";
import { createLogger, errorSummary, type Logger } from "./logger.ts";
import { startRpcServer, type RpcServer } from "./rpc-server.ts";
import { buildMethods } from "./rpc-methods.ts";
import { createWorker, type Worker } from "./worker.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { createRelay, type Relay } from "./relay.ts";
import { reap } from "./reaper.ts";
import { markInterrupted, insertOutbox } from "./store.ts";
import { createJobTokens, type JobTokens } from "./job-tokens.ts";

export interface ServeOptions {
	paths: Paths;
	logger?: Logger;
	concurrency?: number;
	dailyTokenCap?: number | null;
	softLimitRatio?: number;
	/**
	 * Drain budget on SIGTERM. Must stay below the service manager's kill
	 * deadline — systemd's TimeoutStopSec defaults to 90s — or the graceful path
	 * never actually runs in production.
	 */
	shutdownGraceMs?: number;
	workerTickMs?: number;
	relayTickMs?: number;
	/** Age after which rows, session files and their debris are reclaimed. */
	retentionDays?: number;
	/** Injected for tests so deliveries hit a local stub instead of the real API. */
	fetchImpl?: typeof fetch;
	telegramApiBase?: string;
	/** Tests only: spawn a stand-in RPC agent instead of pi. */
	rpcEntryOverride?: string;
	/** Termination chain grace windows; defaults suit production. */
	abortGraceMs?: number;
	termGraceMs?: number;
	/** Skips signal handlers so tests can drive shutdown directly. */
	installSignalHandlers?: boolean;
	/** How many agent-authored schedules may exist at once. */
	aiScheduleQuota?: number;
	/**
	 * Supplies the token registry instead of making one.
	 *
	 * Tests need to mint a token for a job they are only pretending to run; the
	 * daemon otherwise owns this outright.
	 */
	jobTokens?: JobTokens;
}

export interface RunningDaemon {
	stop(): Promise<void>;
	paths: Paths;
	db: Db;
	logger: Logger;
}

const DEFAULTS = {
	// An agent with a scheduler fails by making a hundred schedules, not one.
	aiScheduleQuota: 5,
	concurrency: 2,
	shutdownGraceMs: 60_000,
	softLimitRatio: 0.8,
};

export async function serve(options: ServeOptions): Promise<RunningDaemon> {
	const paths = options.paths;
	const logger = options.logger ?? createLogger();
	const startedAt = nowIso();

	ensureDirs(paths);

	// 1. Singleton first: everything below assumes we own this directory.
	let lock: AcquiredLock;
	try {
		lock = acquireLock(paths.pidFile);
	} catch (err) {
		if (err instanceof LockError) logger.error("lock_denied", { error: err.message });
		throw err;
	}

	let db: Db | undefined;
	let rpc: RpcServer | undefined;
	let worker: Worker | undefined;
	let scheduler: Scheduler | undefined;
	let relay: Relay | undefined;
	let shuttingDown = false;
	const signalCleanup: Array<() => void> = [];
	// Minted per job, revoked when it settles. A restart invalidates every one,
	// which is right: the jobs holding them died with it.
	const jobTokens = options.jobTokens ?? createJobTokens();

	try {
		// 2. Database and schema.
		db = openDb(paths.db);

		// 3. Reclaim what a previous run left behind, before anything starts
		//    claiming work: a leaked agent process keeps spending.
		reap({
			db,
			logger,
			...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
		});

		// 4. Any `running` row belongs to a previous, now-dead daemon. This is an
		//    epistemic state, not a verdict: we cannot know whether the work landed.
		//    markInterrupted also records the runs and queues the notifications, so
		//    "the daemon died under your job" reaches the operator like any other
		//    terminal outcome.
		const interrupted = markInterrupted(db);
		if (interrupted.jobIds.length > 0) {
			logger.warn("jobs_interrupted_at_startup", {
				count: interrupted.jobIds.length,
				jobIds: interrupted.jobIds,
				notified: interrupted.notified,
			});
		}

		// 5. Config. A failure here is fatal: better not running than running with
		//    a trigger that points at a deleted agent.
		let config: Config = loadConfig(paths);
		logger.info("config_loaded", {
			agents: Object.keys(config.agents).length,
			sinks: Object.keys(config.sinks).length,
			triggers: config.triggers.length,
		});

		const reloadConfig = (): { ok: true } | { ok: false; error: string } => {
			try {
				config = loadConfig(paths);
				// Re-arms every trigger. A tripped breaker deliberately survives:
				// clearing it here would mean any reload — including one that only adds
				// an unrelated trigger — silently restarts a schedule someone decided to
				// stop. `pi-reactor schedule resume <id>` is the explicit undo, and
				// `schedule ls` shows what is waiting for it.
				scheduler?.reload();
				return { ok: true };
			} catch (err) {
				// Keep the previous config live; the caller reports the error.
				return { ok: false, error: err instanceof ConfigError ? err.message : errorSummary(err) };
			}
		};

		// 6. Scheduler, so the worker can report outcomes into its breaker.
		const activeDbForScheduler = db;
		scheduler = createScheduler({
			db: activeDbForScheduler,
			logger,
			getConfig: () => config,
			onTripped: (trigger, reason) => {
				// One notification when a schedule stops firing: silence here would
				// look identical to "it is working".
				if (!trigger.notify) return;
				insertOutbox(
					activeDbForScheduler,
					trigger.notify.sink,
					`🔌 schedule "${trigger.id}" tripped (${reason})\n` +
						`It will not fire again until: pi-reactor schedule resume ${trigger.id}`,
				);
			},
		});

		// 7. Worker.
		worker = createWorker({
			db,
			paths,
			logger,
			getConfig: () => config,
			concurrency: options.concurrency ?? DEFAULTS.concurrency,
			dailyTokenCap: options.dailyTokenCap ?? null,
			softLimitRatio: options.softLimitRatio ?? DEFAULTS.softLimitRatio,
			onTriggerOutcome: (triggerId, succeeded) => scheduler?.recordOutcome(triggerId, succeeded),
			jobTokens,
			...(options.rpcEntryOverride !== undefined ? { rpcEntryOverride: options.rpcEntryOverride } : {}),
			...(options.abortGraceMs !== undefined ? { abortGraceMs: options.abortGraceMs } : {}),
			...(options.termGraceMs !== undefined ? { termGraceMs: options.termGraceMs } : {}),
			...(options.workerTickMs !== undefined ? { tickMs: options.workerTickMs } : {}),
		});

		// 8. Outbound relay.
		relay = createRelay({
			db,
			paths,
			logger,
			getConfig: () => config,
			...(options.relayTickMs !== undefined ? { tickMs: options.relayTickMs } : {}),
			...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
			...(options.telegramApiBase !== undefined ? { apiBase: options.telegramApiBase } : {}),
		});

		// 9. Control plane.
		rpc = await startRpcServer({
			socketPath: paths.sock,
			logger,
			methods: buildMethods({
				db,
				paths,
				logger,
				getConfig: () => config,
				reloadConfig,
				rearmSchedules: () => scheduler?.reload(),
				startedAt,
				dailyTokenCap: options.dailyTokenCap ?? null,
				isShuttingDown: () => shuttingDown,
			jobTokens,
				aiScheduleQuota: options.aiScheduleQuota ?? DEFAULTS.aiScheduleQuota,
			}),
		});

		worker.start();
		scheduler.start();
		relay.start();
		logger.info("daemon_ready", { pid: process.pid, socket: paths.sock });
	} catch (err) {
		// Startup failed after the lock was taken: release everything in reverse.
		await rpc?.close();
		db?.close();
		lock.release();
		throw err;
	}

	const activeDb = db;
	const activeRpc = rpc;
	const activeWorker = worker;
	const activeScheduler = scheduler;
	const activeRelay = relay;

	/**
	 * Graceful shutdown: stop accepting, let in-flight jobs finish within the
	 * grace window, then mark whatever is left as interrupted so the next start
	 * does not inherit phantom `running` rows.
	 */
	const stop = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("daemon_stopping");

		// Disarm before draining: a fire during shutdown would enqueue work nobody
		// is left to claim.
		activeScheduler.stop();

		const grace = options.shutdownGraceMs ?? DEFAULTS.shutdownGraceMs;
		const result = await activeWorker.drain(grace);
		if (!result.drained) {
			logger.warn("drain_incomplete", { inFlight: result.inFlight });
			const left = markInterrupted(activeDb);
			if (left.jobIds.length > 0) {
				logger.warn("jobs_marked_interrupted", { jobIds: left.jobIds, notified: left.notified });
			}
		}

		// Flush the outbox before closing: a verdict already reached must reach the
		// operator. Bounded so shutdown cannot hang on an unreachable sink.
		activeRelay.stop();
		await Promise.race([
			activeRelay.flush(),
			new Promise<void>((resolve) => {
				const t = setTimeout(resolve, 5000);
				t.unref();
			}),
		]);

		await activeRpc.close();

		// Close the database only when nothing can still write to it. A job whose
		// drain timed out, or a delivery still awaiting the network, would otherwise
		// resume against a closed handle: the write is lost and the error surfaces as
		// an unrelated mystery. Leaving the handle open costs nothing — process exit
		// releases it, and WAL has already made every committed write durable.
		const relayIdle = await activeRelay.settle(2000);
		if (result.drained && relayIdle) {
			activeDb.close();
		} else {
			logger.warn("db_left_open", { workerDrained: result.drained, relayIdle });
		}
		lock.release();
		for (const cleanup of signalCleanup) cleanup();
		logger.info("daemon_stopped");
	};

	if (options.installSignalHandlers !== false) {
		let stopping = false;
		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			const handler = (): void => {
				// A second signal means the operator is done waiting.
				if (stopping) {
					logger.warn("forced_exit", { signal });
					process.exit(1);
				}
				stopping = true;
				void stop().then(
					() => process.exit(0),
					(err: unknown) => {
						logger.error("shutdown_failed", { error: errorSummary(err) });
						process.exit(1);
					},
				);
			};
			process.on(signal, handler);
			signalCleanup.push(() => process.off(signal, handler));
		}
	}

	return { stop, paths, db: activeDb, logger };
}

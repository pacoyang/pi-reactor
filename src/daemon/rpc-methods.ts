/**
 * Control-plane method implementations.
 *
 * Every config mutation and every query goes through here, so the CLI and the
 * pi extension share one implementation and cannot drift apart.
 * Kept in one file while the set is small; the config methods will split
 * into rpc-methods-config.ts when they arrive, following pi-telegram's prefix
 * grouping. Splitting now would be premature.
 */
import type { Db } from "../core/db.ts";
import { ConfigError, type Config, type NotifyWhen } from "../core/config.ts";
import {
	previewEdit,
	applyEdit,
	addTrigger,
	editTrigger,
	deleteTrigger,
	addAgent,
	editAgent,
	deleteAgent,
	addSink,
	editSink,
	deleteSink,
	setCredential,
	listCredentialFields,
	type Edit,
	type EditPreview,
	type JsonObject,
} from "../core/config-edit.ts";
import type { Paths } from "../core/paths.ts";
import { RPC_ERRORS, RpcError, type EmitResult, type StatusResult } from "../core/rpc-types.ts";
import { validateCloudEvent, cliEvent } from "../core/cloudevents.ts";
import { parseDurationOr } from "../core/duration.ts";
import type { MethodHandler } from "./rpc-server.ts";
import {
	enqueue,
	insertOutbox,
	queueCounts,
	outboxCounts,
	recentRuns,
	runsToday,
	tokensSpentToday,
	isPaused,
	setFlag,
	readJobRouting,
	jobIdForRun,
	locateSessions,
} from "./store.ts";
import { resumeSchedule } from "./scheduler.ts";
import type { JobTokens } from "./job-tokens.ts";
import { errorSummary, type Logger } from "./logger.ts";
export interface MethodDeps {
	db: Db;
	/** Re-arms schedules after a breaker is cleared. */
	rearmSchedules?: () => void;
	paths: Paths;
	logger: Logger;
	getConfig: () => Config;
	reloadConfig: () => { ok: true } | { ok: false; error: string };
	startedAt: string;
	dailyTokenCap: number | null;
	/** Set while draining so new work is refused rather than silently queued. */
	isShuttingDown: () => boolean;
	/** Identifies job callers of `schedule.*`. */
	jobTokens?: JobTokens;
	/** How many agent-authored schedules may exist at once. */
	aiScheduleQuota: number;
}

function requireString(params: Record<string, unknown>, key: string): string {
	const v = params[key];
	if (typeof v !== "string" || v.trim() === "") {
		throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `${key} must be a non-empty string`);
	}
	return v;
}

/**
 * Establishes that the caller is a running job, and which one.
 *
 * The token is minted per job and dies with it, so a stale one from a finished
 * run is refused — which also means an operator's CLI, holding no token at all,
 * cannot reach these methods by accident.
 */
function requireJob(deps: MethodDeps, params: Record<string, unknown>): number {
	const token = params.token;
	if (typeof token !== "string" || token === "") {
		throw new RpcError(RPC_ERRORS.FORBIDDEN, "schedule.* is for running jobs; pass PI_REACTOR_TOKEN as `token`");
	}
	const jobId = deps.jobTokens?.resolve(token);
	if (jobId === undefined) {
		throw new RpcError(RPC_ERRORS.FORBIDDEN, "unknown or expired job token");
	}
	return jobId;
}

function requireObject(params: Record<string, unknown>, key: string): JsonObject {
	const v = params[key];
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `${key} must be a JSON object`);
	}
	return v as JsonObject;
}

export interface ConfigChangeResult extends EditPreview {
	applied: boolean;
}

/**
 * The shared body of every config mutation: build the edit, validate it, and
 * either stop at the preview or write and hot-reload.
 *
 * A `ConfigError` here is the caller's mistake — a duplicate id, a cron
 * expression that never fires, an agent that does not exist — so it comes back
 * as `-32602` with the message intact rather than as an internal error.
 */
function configMethod(deps: MethodDeps, params: Record<string, unknown>, build: () => Edit): ConfigChangeResult {
	const edit = build();
	const dryRun = params.dryRun === true;
	try {
		if (dryRun) return { ...previewEdit(deps.paths, edit).preview, applied: false };

		const preview = applyEdit(deps.paths, edit);
		if (!preview.changed) {
			deps.logger.info("config_unchanged", { edit: edit.summary });
			return { ...preview, applied: false };
		}

		// Hot reload, so a change takes effect without a restart. It cannot fail
		// validation — we just validated the exact bytes we wrote — but a reload
		// that somehow does fail must be loud rather than leave the daemon running
		// on a configuration nobody can see any more.
		const reloaded = deps.reloadConfig();
		if (!reloaded.ok) {
			throw new RpcError(RPC_ERRORS.INTERNAL_ERROR, `wrote ${preview.file} but could not reload: ${reloaded.error}`);
		}
		deps.rearmSchedules?.();
		deps.logger.info("config_changed", { edit: edit.summary, file: preview.file });
		return { ...preview, applied: true };
	} catch (err) {
		if (err instanceof RpcError) throw err;
		if (err instanceof ConfigError) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, err.message);
		throw err;
	}
}

export function buildMethods(deps: MethodDeps): Record<string, MethodHandler> {
	const { db, logger, getConfig } = deps;

	return {
		/**
		 * Accepts an event and enqueues a job in one transaction.
		 *
		 * A duplicate (source,id) returns `duplicate: true` as a SUCCESS: cron
		 * catch-up and webhook redelivery both replay keys legitimately, and the
		 * caller must not treat that as a reason to retry.
		 */
		emit(params): EmitResult {
			if (deps.isShuttingDown()) {
				throw new RpcError(RPC_ERRORS.SHUTTING_DOWN, "daemon is shutting down");
			}
			const config = getConfig();

			const route = params.route;
			if (typeof route !== "object" || route === null) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, "route must be an object");
			}
			const r = route as Record<string, unknown>;
			const agentName = requireString(r, "agent");
			const agent = config.agents[agentName];
			if (!agent) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `unknown agent "${agentName}"`);
			}
			if (r.task === undefined && r.skill === undefined) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, "route needs a task or a skill");
			}

			const lane = params.lane === undefined ? "batch" : String(params.lane);
			if (lane !== "batch") {
				// There is no interactive executor: the lane is reserved in the schema so
				// adding one later needs no migration, but nothing runs it today. Refusing
				// loudly beats silently putting interactive work through the batch queue,
				// where it would be answered minutes later by a notification.
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `lane "${lane}" is not implemented (batch only)`);
			}

			const event = params.ce === undefined
				? cliEvent(typeof params.id === "string" ? params.id : undefined)
				: validateCloudEvent(params.ce);

			let notify: { sink: string; when: "success" | "failure" | "always" } | undefined;
			if (params.notify !== undefined) {
				const n = params.notify as Record<string, unknown>;
				const sink = requireString(n, "sink");
				if (!config.sinks[sink]) {
					throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `unknown sink "${sink}"`);
				}
				const when = n.when === undefined ? "always" : String(n.when);
				if (when !== "success" && when !== "failure" && when !== "always") {
					throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `notify.when must be success | failure | always`);
				}
				notify = { sink, when };
			}

			// A bad duration from a caller is bad PARAMS, not an internal error: the
			// spec's -32602 tells the operator it is their message to fix, while
			// -32603 sends them reading daemon logs for a fault that is not there.
			let maxDurationS: number;
			try {
				maxDurationS = parseDurationOr(r.maxDuration as string | number | undefined, agent.maxDurationS);
			} catch (err) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `route.maxDuration: ${errorSummary(err)}`);
			}

			const result = enqueue(db, {
				event,
				lane,
				agent: agentName,
				task: typeof r.task === "string" ? r.task : undefined,
				skill: typeof r.skill === "string" ? r.skill : undefined,
				triggerId: typeof r.triggerId === "string" ? r.triggerId : undefined,
				maxDurationS,
				requireCleanTree: r.requireCleanTree === true,
				retryable: r.retryable !== false,
				notify,
			});

			logger.info(result.duplicate ? "emit_duplicate" : "emit_accepted", {
				seq: result.seq,
				jobId: result.jobId,
				agent: agentName,
				source: event.source,
			});
			return result;
		},

		/**
		 * Re-runs a past job or run as a NEW job.
		 *
		 * A fresh event with a fresh id rather than reviving the old row: the
		 * original is history and stays that way, and the CloudEvents key of the
		 * thing that already happened must keep meaning that occurrence. Reusing it
		 * would collide with the unique index and silently do nothing.
		 *
		 * Needed most for the outcomes nothing else can recover: a run the daemon
		 * died under is terminal by design (retrying unattended could double-execute
		 * work that is not idempotent), so an operator deciding "yes, run it again"
		 * is exactly the judgement call this exists for.
		 */
		rerun(params): EmitResult {
			if (deps.isShuttingDown()) {
				throw new RpcError(RPC_ERRORS.SHUTTING_DOWN, "daemon is shutting down");
			}
			const jobId = typeof params.job === "number" ? params.job : undefined;
			const runId = typeof params.run === "number" ? params.run : undefined;
			if (jobId === undefined && runId === undefined) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, "rerun needs a job or a run id");
			}

			const targetJob = jobId ?? jobIdForRun(db, runId as number);
			if (targetJob === null) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `run ${runId} has no job left to re-run (aged out)`);
			}
			const routing = readJobRouting(db, targetJob);
			if (!routing) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `no job ${targetJob}`);
			}
			// The agent may have been renamed or deleted since. Refusing here beats
			// enqueuing something the worker can only refuse later.
			if (!getConfig().agents[routing.agent]) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `agent "${routing.agent}" is no longer defined`);
			}

			const result = enqueue(db, {
				event: cliEvent(),
				lane: "batch",
				agent: routing.agent,
				task: routing.task ?? undefined,
				skill: routing.skill ?? undefined,
				triggerId: routing.trigger_id ?? undefined,
				maxDurationS: routing.max_duration_s,
				requireCleanTree: routing.require_clean_tree === 1,
				retryable: routing.retryable === 1,
				...(routing.notify_sink
					? { notify: { sink: routing.notify_sink, when: (routing.notify_when ?? "always") as NotifyWhen } }
					: {}),
			});
			logger.info("rerun_queued", { sourceJob: targetJob, jobId: result.jobId, agent: routing.agent });
			return result;
		},

		status(): StatusResult {
			const config = getConfig();
			return {
				pid: process.pid,
				startedAt: deps.startedAt,
				paused: isPaused(db),
				queue: queueCounts(db),
				outbox: outboxCounts(db),
				today: {
					runs: runsToday(db),
					totalTokens: tokensSpentToday(db),
					cap: deps.dailyTokenCap,
				},
				agents: Object.keys(config.agents),
			};
		},

		runs(params) {
			const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 200) : 20;
			return { runs: recentRuns(db, limit, params.dead === true) };
		},

		/**
		 * Where a session this daemon ran actually lives.
		 *
		 * `resume` finds sessions by globbing pi's default directory, which needs
		 * no daemon at all — but pi's `sessionDir` setting is cwd-bound, so an
		 * agent with a project-local one writes where no fixed glob will look.
		 * This is the authoritative answer for those: the path pi reported at the
		 * handshake, recorded verbatim.
		 */
		"session.locate"(params) {
			// Paths only; whether the file still exists is the caller's own stat to
			// make — it shares this filesystem, the socket being local by design.
			return { sessions: locateSessions(db, requireString(params, "session")) };
		},

		/**
		 * Writes a notification to the outbox and returns immediately.
		 *
		 * Deliberately does not wait for delivery: this is the entry point agents
		 * call mid-run, and a network hiccup must not stall the agent's tool call.
		 */
		notify(params) {
			const sink = requireString(params, "sink");
			const body = requireString(params, "body");
			if (!getConfig().sinks[sink]) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `unknown sink "${sink}"`);
			}
			const outboxId = insertOutbox(db, sink, body);
			logger.info("notify_queued", { sink, outboxId, bytes: body.length });
			return { outboxId };
		},

		/**
		 * Agent self-scheduling: `trigger.add` restricted to what a job may do.
		 *
		 * Same storage, same validation, same breaker — this is a narrower door onto
		 * `trigger.*`, not a parallel mechanism. What the narrowing buys:
		 *   - a token proves the caller is a running job, so what it writes can be
		 *     marked `aiAuthored` and told apart from what a human asked for
		 *   - cron only: a job cannot open a public webhook endpoint
		 *   - a quota, because the failure mode of an agent with a scheduler is not
		 *     one bad schedule, it is a hundred
		 *
		 * On the strength of the token, see job-tokens.ts: this is a guardrail
		 * against mistakes and casual injection, not a boundary against an attacker
		 * who already runs code as this user.
		 */
		"schedule.add"(params) {
			const jobId = requireJob(deps, params);
			const config = getConfig();
			const authored = config.triggers.filter((t) => t.kind === "cron" && t.aiAuthored).length;
			if (authored >= deps.aiScheduleQuota) {
				throw new RpcError(
					RPC_ERRORS.FORBIDDEN,
					`agent-authored schedule quota reached (${authored}/${deps.aiScheduleQuota}); ` +
						`remove one with pi-reactor trigger rm <id>`,
				);
			}

			const id = requireString(params, "id");
			const schedule = requireString(params, "schedule");
			const agent = requireString(params, "agent");
			if (!config.agents[agent]) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `unknown agent "${agent}"`);
			if (params.task === undefined && params.skill === undefined) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, "schedule.add needs a task or a skill");
			}

			const entry: JsonObject = {
				on: {
					type: "cron",
					id,
					schedule,
					...(typeof params.timezone === "string" ? { timezone: params.timezone } : {}),
				},
				run: {
					agent,
					...(typeof params.task === "string" ? { task: params.task } : {}),
					...(typeof params.skill === "string" ? { skill: params.skill } : {}),
				},
				...(typeof params.notify === "string" ? { notify: { sink: params.notify, when: "always" } } : {}),
				// Written into the file, not held in memory: whoever reads the config
				// later should be able to see which entries an agent asked for.
				aiAuthored: true,
			};

			const result = configMethod(deps, params, () => addTrigger(entry));
			logger.info("schedule_self_added", { jobId, triggerId: id, authored: authored + 1 });
			return result;
		},

		/** The other half: a job may withdraw a schedule it created, and only that. */
		"schedule.rm"(params) {
			const jobId = requireJob(deps, params);
			const id = requireString(params, "id");
			const existing = getConfig().triggers.find((t) => t.id === id);
			if (!existing) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `no trigger "${id}"`);
			if (existing.kind !== "cron" || !existing.aiAuthored) {
				throw new RpcError(RPC_ERRORS.FORBIDDEN, `trigger "${id}" was not created by an agent; an operator has to remove it`);
			}
			const result = configMethod(deps, params, () => deleteTrigger(id));
			logger.info("schedule_self_removed", { jobId, triggerId: id });
			return result;
		},

		/** Lists schedule runtime state: watermark, failure count, breaker. */
		"schedule.ls"() {
			const rows = db
				.prepare(
					`SELECT trigger_id AS id, last_fired_at AS lastFiredAt,
					        consecutive_failures AS consecutiveFailures, tripped_at AS trippedAt
					 FROM schedules ORDER BY trigger_id`,
				)
				.all() as Array<Record<string, unknown>>;
			const configured = new Set(getConfig().triggers.filter((t) => t.kind === "cron").map((t) => t.id));
			return {
				schedules: rows.map((r) => ({ ...r, configured: configured.has(String(r.id)) })),
			};
		},

		/** Clears a tripped breaker and re-arms, so a fixed schedule fires again. */
		"schedule.resume"(params) {
			const id = requireString(params, "id");
			if (!resumeSchedule(db, id)) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `no schedule state for trigger "${id}"`);
			}
			deps.rearmSchedules?.();
			logger.info("schedule_resumed", { triggerId: id });
			return { resumed: true };
		},

		// ---------------------------------------------------------- config
		//
		// Every mutation takes `dryRun`, and every one returns before -> after. That
		// is the confirmation gate's whole supply: the extension shows the operator a
		// document the daemon has ALREADY validated, so an approval cannot be
		// followed by a rejection.

		"trigger.ls"() {
			return { triggers: getConfig().triggers };
		},

		"trigger.add": (params) => configMethod(deps, params, () => addTrigger(requireObject(params, "trigger"))),
		"trigger.edit": (params) =>
			configMethod(deps, params, () => editTrigger(requireString(params, "id"), requireObject(params, "trigger"))),
		"trigger.delete": (params) => configMethod(deps, params, () => deleteTrigger(requireString(params, "id"))),

		"agent.ls"() {
			return { agents: Object.values(getConfig().agents) };
		},

		"agent.add": (params) => configMethod(deps, params, () => addAgent(requireString(params, "name"), requireObject(params, "agent"))),
		"agent.edit": (params) => configMethod(deps, params, () => editAgent(requireString(params, "name"), requireObject(params, "agent"))),
		"agent.delete": (params) => configMethod(deps, params, () => deleteAgent(requireString(params, "name"))),

		"sink.ls"() {
			// Which credential FIELDS are set, never their values: this answers "is
			// the bot token in place?" without putting it in the model's context.
			return {
				sinks: Object.values(getConfig().sinks).map((sink) => ({
					...sink,
					credentials: listCredentialFields(deps.paths, sink.name),
				})),
			};
		},

		"sink.add": (params) => configMethod(deps, params, () => addSink(requireString(params, "name"), requireObject(params, "sink"))),
		"sink.edit": (params) => configMethod(deps, params, () => editSink(requireString(params, "name"), requireObject(params, "sink"))),
		"sink.delete": (params) => configMethod(deps, params, () => deleteSink(requireString(params, "name"))),

		/**
		 * Stores a credential. Never goes through the confirmation gate: the
		 * value is pasted, written at 0600 and never echoed — not to the caller, not
		 * to the log, and above all not into a config file the gate would display.
		 */
		"credential.set"(params) {
			const name = requireString(params, "name");
			const field = requireString(params, "field");
			const value = requireString(params, "value");
			try {
				setCredential(deps.paths, name, field, value);
			} catch (err) {
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, errorSummary(err));
			}
			logger.info("credential_set", { name, field, bytes: value.length });
			return { name, field, stored: true };
		},

		pause() {
			setFlag(db, "paused", "1");
			logger.info("queue_paused");
			return { paused: true };
		},

		resume() {
			setFlag(db, "paused", "0");
			logger.info("queue_resumed");
			return { paused: false };
		},

		/**
		 * Reloads config from disk. On a validation failure the PREVIOUS config
		 * stays live and the error is returned: a bad edit must not take the
		 * daemon down or silently disable existing triggers.
		 */
		reload() {
			const result = deps.reloadConfig();
			if (!result.ok) {
				logger.warn("config_reload_rejected", { error: result.error });
				throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `config rejected, keeping the previous one: ${result.error}`);
			}
			const config = getConfig();
			logger.info("config_reloaded", {
				agents: Object.keys(config.agents).length,
				sinks: Object.keys(config.sinks).length,
				triggers: config.triggers.length,
			});
			return { agents: Object.keys(config.agents).length, triggers: config.triggers.length };
		},
	};
}

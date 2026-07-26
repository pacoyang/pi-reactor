/**
 * Outbox relay: the polling publisher half of the transactional outbox pattern
 *.
 *
 * Delivery is decoupled from execution on purpose. The notification is committed
 * in the same transaction as the run record, so once a job reaches a verdict the
 * message WILL be delivered — even if the agent was SIGKILLed, even if the daemon
 * restarts a second later. Relying on the agent to send its own notification
 * loses exactly the messages you most want: the ones about a run that died.
 *
 * Semantics are at-least-once. If the process dies between a successful send and
 * marking the row `sent`, the message goes out twice on restart. That direction
 * is chosen deliberately: for notifications a duplicate is noise, a loss is an
 * outage you never hear about. (This is the opposite of pi-telegram's rule for
 * turn REPLIES, where a duplicate would corrupt a conversation — different
 * payload, different correct answer.)
 */
import type { Db } from "../core/db.ts";
import { nowIso } from "../core/db.ts";
import type { Config, SinkSpec } from "../core/config.ts";
import type { Paths } from "../core/paths.ts";
import { resolveSinkCredential, readCredentialsFile } from "../core/credentials.ts";
import { sendTelegram, type SendResult } from "./sink-telegram.ts";
import { sendSlack } from "./sink-slack.ts";
import { backoffSeconds, withJitter } from "./outcome.ts";
import type { Logger } from "./logger.ts";
import { errorSummary } from "./logger.ts";

/** Attempts before a message is given up on and parked in the dead state. */
export const MAX_ATTEMPTS = 8;

/**
 * Deliveries per drain. Not a throughput limit — each iteration either sends a
 * message or moves one out of the due set, so the loop always terminates on its
 * own. This is a backstop against a bug that makes a row perpetually due, so one
 * tick cannot spin forever.
 */
const MAX_PER_DRAIN = 100;

export interface OutboxRow {
	id: number;
	run_id: number | null;
	sink: string;
	body: string;
	attempts: number;
}

export interface RelayOptions {
	db: Db;
	paths: Paths;
	logger: Logger;
	getConfig: () => Config;
	tickMs?: number;
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
	/** Override the Telegram API origin for tests. */
	apiBase?: string;
}

export interface Relay {
	start(): void;
	stop(): void;
	/** Delivers everything currently due; returns how many were sent. Used by tests and shutdown. */
	flush(): Promise<number>;
	/**
	 * Resolves true once no delivery is in flight, false if the deadline passes.
	 * Shutdown uses it to decide whether closing the database is safe.
	 */
	settle(graceMs: number): Promise<boolean>;
}

const DEFAULT_TICK_MS = 1000;

export function createRelay(options: RelayOptions): Relay {
	const { db, paths, logger, getConfig } = options;
	const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
	let timer: NodeJS.Timeout | undefined;
	let inFlight: Promise<number> | undefined;

	function claimDue(): OutboxRow | undefined {
		return db
			.prepare(
				`SELECT id, run_id, sink, body, attempts FROM outbox
				 WHERE state = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?)
				 ORDER BY created_at, id LIMIT 1`,
			)
			.get(nowIso()) as OutboxRow | undefined;
	}

	async function deliver(row: OutboxRow, sinks: Record<string, SinkSpec>): Promise<boolean> {
		const sink = sinks[row.sink];
		if (!sink) {
			// The sink was removed from config while the message waited. There is
			// nowhere to send it and no amount of retrying will help.
			logger.warn("outbox_sink_missing", { outboxId: row.id, sink: row.sink });
			markDead(row, `sink "${row.sink}" is no longer configured`);
			return false;
		}

		let result: SendResult;
		try {
			result = await send(row, sink);
		} catch (err) {
			result = { ok: false, error: errorSummary(err) };
		}

		if (result.ok) {
			// The crash window is right here: if we die before this UPDATE, the
			// message is re-sent on restart. Accepted, see the header.
			db.prepare("UPDATE outbox SET state = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?")
				.run(nowIso(), row.id);
			logger.info("outbox_sent", { outboxId: row.id, sink: row.sink, attempts: row.attempts + 1 });
			return true;
		}

		if (result.throttled) {
			// Rate limiting is not failure: obey their retry_after and leave the
			// attempt count alone, or a busy chat would exhaust the budget.
			const waitS = result.retryAfterSeconds ?? 30;
			db.prepare("UPDATE outbox SET scheduled_at = ? WHERE id = ?")
				.run(new Date(Date.now() + waitS * 1000).toISOString(), row.id);
			logger.warn("outbox_throttled", { outboxId: row.id, sink: row.sink, retryAfterS: waitS });
			return false;
		}

		const attempts = row.attempts + 1;
		if (attempts >= MAX_ATTEMPTS) {
			markDead(row, result.error ?? "unknown error");
			return false;
		}

		// Jittered: several messages that fail together would otherwise retry against
		// the same API in the same second, forever in lockstep.
		const waitS = withJitter(backoffSeconds(row.attempts));
		db.prepare("UPDATE outbox SET attempts = ?, scheduled_at = ? WHERE id = ?")
			.run(attempts, new Date(Date.now() + waitS * 1000).toISOString(), row.id);
		logger.warn("outbox_retry", { outboxId: row.id, sink: row.sink, attempts, waitS, error: result.error });
		return false;
	}

	function markDead(row: OutboxRow, why: string): void {
		db.prepare("UPDATE outbox SET state = 'dead', attempts = attempts + 1 WHERE id = ?").run(row.id);
		logger.error("outbox_dead", { outboxId: row.id, sink: row.sink, error: why });
	}

	async function send(row: OutboxRow, sink: SinkSpec): Promise<SendResult> {
		// Read the credentials file once per delivery rather than once per lookup.
		const preloaded = readCredentialsFile(paths.credentialsFile);

		switch (sink.kind) {
			case "telegram": {
				const token = resolveSinkCredential(sink.name, "botToken", {
					credentialsFile: paths.credentialsFile,
					preloaded,
				});
				if (!token) {
					return { ok: false, error: `no botToken for sink "${sink.name}" (credentials.json or REACTOR_${sink.name.toUpperCase()}_BOT_TOKEN)` };
				}
				return sendTelegram({
					sink,
					botToken: token.value,
					body: row.body,
					...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
					...(options.apiBase ? { apiBase: options.apiBase } : {}),
				});
			}
			case "slack-webhook": {
				// The whole endpoint is the credential — a Slack incoming webhook URL
				// carries its own authorisation — so it lives in credentials.json like
				// any other secret and never in sinks.json.
				const url = resolveSinkCredential(sink.name, "webhookUrl", {
					credentialsFile: paths.credentialsFile,
					preloaded,
				});
				if (!url) {
					return { ok: false, error: `no webhookUrl for sink "${sink.name}" (pi-reactor secret set ${sink.name} webhookUrl)` };
				}
				return sendSlack({
					sink,
					webhookUrl: url.value,
					body: row.body,
					...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
				});
			}
			default:
				return { ok: false, error: `unknown sink kind` };
		}
	}

	async function drain(): Promise<number> {
		let sent = 0;
		try {
			const sinks = getConfig().sinks;
			// One at a time: ordering matters more than throughput for notifications,
			// and it keeps a stuck sink from blocking others behind a batch.
			for (let i = 0; i < MAX_PER_DRAIN; i++) {
				const row = claimDue();
				if (!row) break;
				if (await deliver(row, sinks)) sent++;
				// Not sent: the row is now throttled, backed off or dead, so the next
				// claimDue will not select it. Carry on rather than stopping — one
				// unreachable sink must not block every other message, and a flush at
				// shutdown would otherwise deliver nothing past the first failure.
			}
		} catch (err) {
			logger.error("relay_tick_failed", { error: errorSummary(err) });
		}
		return sent;
	}

	/** At most one drain at a time; concurrent callers join the one in progress. */
	function drainOnce(): Promise<number> {
		if (inFlight) return inFlight;
		const run = drain().finally(() => {
			inFlight = undefined;
		});
		inFlight = run;
		return run;
	}

	return {
		start() {
			if (timer) return;
			timer = setInterval(() => void drainOnce(), tickMs);
			timer.unref();
			setImmediate(() => void drainOnce());
		},

		stop() {
			if (timer) clearInterval(timer);
			timer = undefined;
		},

		/**
		 * Joins any drain already running, THEN runs one of its own.
		 *
		 * Returning 0 while a delivery was mid-flight was the earlier behaviour, and
		 * shutdown believed it: it closed the database out from under an in-flight
		 * send, whose UPDATE then threw and left the row pending to be re-sent.
		 */
		async flush() {
			await inFlight?.catch(() => 0);
			return drainOnce();
		},

		async settle(graceMs) {
			if (!inFlight) return true;
			return Promise.race([
				inFlight.then(
					() => true,
					() => true,
				),
				new Promise<boolean>((resolve) => {
					const t = setTimeout(() => resolve(false), graceMs);
					t.unref();
				}),
			]);
		},
	};
}

/** Pending, non-dead outbox rows — used by `status` and shutdown reporting. */
export function pendingOutboxCount(db: Db): number {
	return (db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get() as { n: number }).n;
}

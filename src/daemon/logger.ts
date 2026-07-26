/**
 * Structured logging.
 *
 * One JSONL record per line on stdout, collected by the process manager
 * (systemd to journald, tmux to its scrollback). No self-built file rotation —
 * this is 12-factor's "logs as event streams": the process only writes, and
 * rotation, querying and disk quota belong to journald (`journalctl -u
 * pi-reactor`). pi-telegram writes its own logs.jsonl because it lives inside
 * the pi process and has no process manager to lean on; we do, so we skip that.
 *
 * Field shape mirrors pino so that swapping in pino later (for sampling, child
 * loggers, transports) leaves call sites untouched.
 *
 * PII-free is a hard constraint: ids, states, durations, token counts and error
 * summaries only. Never task text, assistant output, or issue bodies — the same
 * rule the runs table follows.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
	[key: string]: unknown;
}

export interface Logger {
	debug(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
	/** Derives a child logger with bound fields, e.g. `{ jobId }`. */
	child(bound: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
	/** Records below this level are dropped. Defaults to info; PI_REACTOR_LOG_LEVEL overrides. */
	level?: LogLevel;
	/** Injected for tests; defaults to stdout. */
	write?: (line: string) => void;
	/** Injected for tests; defaults to the wall clock. */
	now?: () => Date;
}

function isLevel(v: unknown): v is LogLevel {
	return v === "debug" || v === "info" || v === "warn" || v === "error";
}

export function createLogger(options: LoggerOptions = {}): Logger {
	const envLevel = process.env.PI_REACTOR_LOG_LEVEL;
	const level: LogLevel = options.level ?? (isLevel(envLevel) ? envLevel : "info");
	const threshold = LEVEL_ORDER[level];
	const write = options.write ?? ((line: string) => process.stdout.write(line));
	const now = options.now ?? (() => new Date());

	const emit = (lvl: LogLevel, bound: LogFields, event: string, fields?: LogFields): void => {
		if (LEVEL_ORDER[lvl] < threshold) return;
		// Key order is deliberate: ts/level/event first, so a truncated line still reads.
		const record = { ts: now().toISOString(), level: lvl, event, ...bound, ...fields };
		let line: string;
		try {
			line = JSON.stringify(record);
		} catch {
			// A circular reference or BigInt slipped into the fields. Logging must
			// never be the thing that takes the daemon down.
			line = JSON.stringify({ ts: now().toISOString(), level: "error", event: "log_serialize_failed", of: event });
		}
		write(`${line}\n`);
	};

	const make = (bound: LogFields): Logger => ({
		debug: (event, fields) => emit("debug", bound, event, fields),
		info: (event, fields) => emit("info", bound, event, fields),
		warn: (event, fields) => emit("warn", bound, event, fields),
		error: (event, fields) => emit("error", bound, event, fields),
		child: (extra) => make({ ...bound, ...extra }),
	});

	return make({});
}

/** Flattens any thrown value into one safe line: no stack, no user content. */
export function errorSummary(err: unknown, maxLength = 300): string {
	const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	const oneLine = raw.replace(/\s+/g, " ").trim();
	return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

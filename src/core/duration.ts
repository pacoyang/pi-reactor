/**
 * Duration literals: `"30m"` / `"90s"` / `"2h"` / `"1d"` / bare number (seconds).
 *
 * Used by `maxDuration`, `shutdownGraceSec`, `retentionDays` and friends.
 * Deliberately no `ms` / `parse-duration` dependency: we need four units and we
 * need fail-loud behaviour — those libraries return NaN or undefined for input
 * they cannot parse, which defers a config mistake to runtime.
 */

export class DurationError extends Error {
	override readonly name = "DurationError";
}

const PATTERN = /^(\d+)\s*(s|m|h|d)?$/;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/**
 * Parses to seconds. Invalid input throws `DurationError`, which the config
 * loader turns into a refusal to start rather than a silent default.
 */
export function parseDuration(value: string | number): number {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
			throw new DurationError(`duration must be a non-negative integer number of seconds, got ${value}`);
		}
		return value;
	}
	// Reject anything else outright rather than letting String() coerce it. `[1]`
	// stringifies to "1" and used to parse as one second, so an `emit` carrying
	// `maxDuration: [1]` silently got a 1s deadline — the exact deferred-to-runtime
	// mistake this module exists to prevent.
	if (typeof value !== "string") {
		throw new DurationError(`duration must be a string or a number, got ${typeof value}`);
	}
	const match = PATTERN.exec(value.trim());
	if (!match) {
		throw new DurationError(
			`invalid duration ${JSON.stringify(value)} (expected e.g. "30m", "90s", "2h", "1d", or seconds)`,
		);
	}
	const amount = Number(match[1]);
	const unit = (match[2] ?? "s") as keyof typeof UNIT_SECONDS;
	return amount * UNIT_SECONDS[unit];
}

/** Optional field: only undefined/null takes the fallback; invalid still throws. */
export function parseDurationOr(value: string | number | undefined | null, fallbackSeconds: number): number {
	if (value === undefined || value === null) return fallbackSeconds;
	return parseDuration(value);
}

/** Human-readable duration for logs and notifications (`2m14s`). */
export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	if (m < 60) return s === 0 ? `${m}m` : `${m}m${s}s`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

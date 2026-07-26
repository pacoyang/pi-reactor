import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration, parseDurationOr, formatDuration, DurationError } from "../src/core/duration.ts";

test("parseDuration: every unit", () => {
	assert.equal(parseDuration("90s"), 90);
	assert.equal(parseDuration("30m"), 1800);
	assert.equal(parseDuration("2h"), 7200);
	assert.equal(parseDuration("1d"), 86400);
	assert.equal(parseDuration("45"), 45, "bare numeric string means seconds");
	assert.equal(parseDuration(60), 60, "a number means seconds");
	assert.equal(parseDuration(" 30m "), 1800, "surrounding whitespace tolerated");
});

test("parseDuration: invalid input fails loud rather than defaulting silently", () => {
	for (const bad of ["", "abc", "30x", "-5", "1.5h", "m", "30 m 20"]) {
		assert.throws(() => parseDuration(bad), DurationError, `should reject ${JSON.stringify(bad)}`);
	}
	assert.throws(() => parseDuration(-1), DurationError);
	assert.throws(() => parseDuration(1.5), DurationError);
	assert.throws(() => parseDuration(Number.NaN), DurationError);
});

test("parseDurationOr: only undefined/null takes the fallback; invalid still throws", () => {
	assert.equal(parseDurationOr(undefined, 1800), 1800);
	assert.equal(parseDurationOr(null, 1800), 1800);
	assert.equal(parseDurationOr("5m", 1800), 300);
	assert.throws(() => parseDurationOr("nope", 1800), DurationError,
		"invalid must throw: silently defaulting lets a config mistake surface at 3am");
});

test("a non-string, non-number is refused rather than coerced", () => {
	// `[1]` stringifies to "1" and used to parse as one second, so an emit
	// carrying `maxDuration: [1]` silently got a 1s deadline and every run under
	// it timed out. Fail-loud is the whole reason this module exists.
	for (const value of [[1], {}, true, ["5m"]] as unknown[]) {
		assert.throws(() => parseDuration(value as string), DurationError, `${JSON.stringify(value)} must be refused`);
	}
});

test("formatDuration", () => {
	assert.equal(formatDuration(45), "45s");
	assert.equal(formatDuration(60), "1m");
	assert.equal(formatDuration(134), "2m14s");
	assert.equal(formatDuration(3600), "1h0m");
	assert.equal(formatDuration(5430), "1h30m");
});

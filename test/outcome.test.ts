import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, refused, shouldRetry, backoffSeconds, withJitter, isPolicyReason, isInfraReason } from "../src/daemon/outcome.ts";

test("determinate success: the agent ran and concluded, including 'I cannot'", () => {
	const c = classify({ settled: true, stopReason: "stop", exitCode: 0 });
	assert.equal(c.outcome, "succeeded");
	assert.equal(c.reason, undefined);
	assert.equal(c.retryable, false,
		"'I cannot fix this' is a conclusion and the product itself, not a failure to pay for twice");
});

test("timeout is policy class and never retries", () => {
	const c = classify({ timedOut: true, settled: false });
	assert.equal(c.outcome, "failed");
	assert.equal(c.reason, "timeout");
	assert.equal(c.retryable, false, "retrying without changing maxDuration just spends the same money again");
	assert.ok(isPolicyReason(c.reason));
});

test("timeout outranks every other signal", () => {
	// The provider may also error while the termination chain runs, but the verdict is ours.
	const c = classify({ timedOut: true, stopReason: "error", errorMessage: "boom", exitCode: 137, signal: "SIGKILL" });
	assert.equal(c.reason, "timeout");
});

test("never reached agent_settled means crash (infra, retryable)", () => {
	const c = classify({ settled: false, exitCode: null, signal: "SIGKILL" });
	assert.equal(c.outcome, "failed");
	assert.equal(c.reason, "crash");
	assert.equal(c.retryable, true);
	assert.ok(isInfraReason(c.reason));
});

test("a provider failure yields provider_error (infra, retryable)", () => {
	// Measured shape: stopReason "error" with an errorMessage in the same frame.
	const a = classify({ settled: true, stopReason: "error", errorMessage: "400 upstream request failed", exitCode: 0 });
	assert.equal(a.reason, "provider_error");
	assert.equal(a.retryable, true);

	// An errorMessage without a stopReason counts too.
	const b = classify({ settled: true, errorMessage: "network reset", exitCode: 0 });
	assert.equal(b.reason, "provider_error");
});

test("non-zero exit or signal means crash; unclassifiable outcomes are treated as infra", () => {
	assert.equal(classify({ settled: true, exitCode: 1 }).reason, "crash");
	assert.equal(classify({ settled: true, exitCode: 143 }).reason, "crash");
	assert.equal(classify({ settled: true, exitCode: null, signal: "SIGTERM" }).reason, "crash");
	assert.equal(classify({ settled: true, exitCode: 1 }).retryable, true,
		"an unclassifiable outcome should retry once and alert rather than pass as success");
});

test("empty stopReason and empty errorMessage are not mistaken for provider_error", () => {
	const c = classify({ settled: true, stopReason: undefined, errorMessage: "", exitCode: 0 });
	assert.equal(c.outcome, "succeeded");
});

test("shape of refused", () => {
	assert.deepEqual(refused("budget_exceeded"), { outcome: "failed", reason: "budget_exceeded", retryable: false });
	assert.deepEqual(refused("config_error"), { outcome: "failed", reason: "config_error", retryable: false });
	// There is deliberately no `interrupted()` classifier: nothing about a run
	// produces that outcome. It comes from store.markInterrupted's startup scan.
});

test("shouldRetry needs all three conditions", () => {
	const infra = classify({ settled: false });
	const policy = classify({ timedOut: true });

	assert.equal(shouldRetry(infra, true, 0), true);
	assert.equal(shouldRetry(infra, false, 0), false, "the trigger declares itself non-retryable (non-idempotent work)");
	assert.equal(shouldRetry(infra, true, 3), false, "attempts exhausted");
	assert.equal(shouldRetry(policy, true, 0), false, "policy class never retries");
	assert.equal(shouldRetry(classify({ settled: true, exitCode: 0 }), true, 0), false, "success does not retry");
});

test("backoff ladder 1m/5m/30m, then held", () => {
	assert.equal(backoffSeconds(0), 60);
	assert.equal(backoffSeconds(1), 300);
	assert.equal(backoffSeconds(2), 1800);
	assert.equal(backoffSeconds(99), 1800);
});

test("jitter spreads over the second half of the window, never below it", () => {
	// Equal jitter: base/2 + rand(0, base/2). The floor is what distinguishes it
	// from AWS's Full Jitter — a 60s backoff that can fire after 3s is not a
	// backoff, and for notifications the wait is the point.
	assert.equal(withJitter(60, () => 0), 30);
	assert.equal(withJitter(60, () => 1), 60);
	assert.equal(withJitter(60, () => 0.5), 45);

	// And it is actually spread, not a constant.
	const draws = new Set(Array.from({ length: 50 }, () => withJitter(1800)));
	assert.ok(draws.size > 10, "a deterministic ladder would put every failed peer on the same instant");
	for (const d of draws) assert.ok(d >= 900 && d <= 1800, `${d} outside [900, 1800]`);
});

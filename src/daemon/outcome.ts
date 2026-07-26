/**
 * Outcome classification and the retry contract. Pure, no IO.
 *
 * The load-bearing claim, inherited from pi-dispatch's exit-code.mjs:
 *   an agent saying "I cannot fix this" is a determinate conclusion and the
 *   product itself, not a failure to paper over by paying for it again.
 *
 * Three classes, only infra retries:
 *   determinate-success  agent ran and concluded (incl. "cannot")  -> succeeded, no retry
 *   infra                crash / network / provider 5xx or 429     -> failed, retryable (<=3 backed off)
 *   policy               budget refusal / timeout / config refusal -> failed, no retry
 *
 * Anything unclassifiable is treated as infra: retrying once and alerting beats
 * silently recording it as a success.
 */

export type Outcome = "succeeded" | "failed" | "interrupted";

/** Policy reasons never retry; infra reasons are the only retryable class. */
export type Reason = "timeout" | "budget_exceeded" | "config_error" | "provider_error" | "crash";

export const POLICY_REASONS = ["timeout", "budget_exceeded", "config_error"] as const;
export const INFRA_REASONS = ["provider_error", "crash"] as const;

export interface Classification {
	outcome: Outcome;
	reason?: Reason;
	/** Only says the outcome belongs to a retryable class; job.retryable and attempts still gate it. */
	retryable: boolean;
}

export interface RunSignals {
	/** stopReason of the last assistant message ("error" when the provider failed). */
	stopReason?: string | undefined;
	/** errorMessage from the same frame as a failing stopReason. */
	errorMessage?: string | undefined;
	/** Child exit code; null when killed by a signal. */
	exitCode?: number | null | undefined;
	/** Terminating signal, e.g. SIGKILL. */
	signal?: string | null | undefined;
	/** We drove the termination chain because maxDuration elapsed. */
	timedOut?: boolean | undefined;
	/** Whether `agent_settled` was ever observed. */
	settled?: boolean | undefined;
}

export function isPolicyReason(reason: Reason | undefined): boolean {
	return reason !== undefined && (POLICY_REASONS as readonly string[]).includes(reason);
}

export function isInfraReason(reason: Reason | undefined): boolean {
	return reason !== undefined && (INFRA_REASONS as readonly string[]).includes(reason);
}

/**
 * Classifies one run's signals. Order is priority:
 *   timeout > never settled (crash) > provider error > non-zero exit > clean finish
 */
export function classify(signals: RunSignals): Classification {
	// 1. A timeout is a verdict WE made. Policy class, never retried: retrying
	//    without changing maxDuration just spends the same money again.
	if (signals.timedOut) {
		return { outcome: "failed", reason: "timeout", retryable: false };
	}

	// 2. Gone before `agent_settled` -> the process crashed or was killed. Infra.
	if (signals.settled === false) {
		return { outcome: "failed", reason: "crash", retryable: true };
	}

	// 3. Provider-side failure. Measured shape: stopReason "error" with an
	//    errorMessage in the same frame.
	if (signals.stopReason === "error" || (signals.errorMessage !== undefined && signals.errorMessage !== "")) {
		return { outcome: "failed", reason: "provider_error", retryable: true };
	}

	// 4. Exit status. Zero is normal; anything else we cannot reason about, so
	//    treat it as infra.
	if (signals.exitCode !== undefined && signals.exitCode !== null && signals.exitCode !== 0) {
		return { outcome: "failed", reason: "crash", retryable: true };
	}
	if (signals.signal) {
		return { outcome: "failed", reason: "crash", retryable: true };
	}

	// 5. The agent ran and reached a conclusion -- including "I cannot do this".
	return { outcome: "succeeded", retryable: false };
}

/** Shortcut for a preflight refusal: there are no run signals before spawn. */
export function refused(reason: Extract<Reason, "budget_exceeded" | "config_error">): Classification {
	return { outcome: "failed", reason, retryable: false };
}

// The `interrupted` outcome has no classifier: nothing about a run produces it.
// It is written by store.markInterrupted, from the startup scan of rows a dead
// daemon left `running` — an epistemic state (the harness died, the verdict is
// unknown), not a verdict about the work.

/** All three conditions must hold before a job goes back to pending. */
export function shouldRetry(c: Classification, jobRetryable: boolean, attempts: number, maxAttempts = 3): boolean {
	return c.retryable && jobRetryable && attempts < maxAttempts;
}

/** Backoff ladder: one minute, then five, then thirty and hold. */
export function backoffSeconds(attempts: number): number {
	const ladder = [60, 300, 1800];
	return ladder[Math.min(attempts, ladder.length - 1)] ?? 1800;
}

/**
 * Spreads a backoff over the second half of its window: `base/2 + rand(0, base/2)`.
 *
 * "Equal jitter" from AWS's *Exponential Backoff And Jitter*, kept rather than
 * their Full Jitter because a notification retried after 3 of its 60 seconds is
 * not really backed off at all. Google SRE makes the same recommendation: a
 * deterministic ladder synchronises every failed peer onto the same instant, and
 * ours all retry against one external API.
 */
export function withJitter(seconds: number, random: () => number = Math.random): number {
	const half = seconds / 2;
	return Math.round(half + random() * half);
}

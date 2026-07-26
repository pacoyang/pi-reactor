/**
 * Per-job capability tokens.
 *
 * A running job gets a random token in its environment. Presenting it is how a
 * caller says "I am job 7", which is what `schedule.*` needs in order to mark
 * what it writes as agent-authored and to hold it to a quota.
 *
 * Its strength is worth stating plainly, because a token LOOKS like a security
 * boundary and this one is not: a job runs as the same uid as the operator, so
 * it can read anything the operator can, including other tokens and the socket
 * itself. **This is a guardrail against mistakes and casual prompt injection,
 * not a defence against a targeted attacker.** The real control is the
 * collaborator gate on what can trigger a job at all; a hard boundary would take
 * container isolation, which is only worth building if triggering is ever opened
 * to strangers.
 *
 * Tokens live only in memory. A daemon restart invalidates every one of them,
 * which is correct: the jobs holding them died with it.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export interface JobTokens {
	/** Mints a token for a job that is about to start. */
	issue(jobId: number): string;
	/** The job this token belongs to, or undefined. */
	resolve(token: string): number | undefined;
	/** Called when the job settles; the token stops working immediately. */
	revoke(jobId: number): void;
	size(): number;
}

export function createJobTokens(): JobTokens {
	const byToken = new Map<string, number>();
	const byJob = new Map<number, string>();

	return {
		issue(jobId) {
			// Replace rather than add: a retried job is the same job, and leaving the
			// old token live would outlive the process it was minted for.
			const previous = byJob.get(jobId);
			if (previous) byToken.delete(previous);

			const token = randomBytes(24).toString("base64url");
			byToken.set(token, jobId);
			byJob.set(jobId, token);
			return token;
		},

		resolve(token) {
			// Constant-time comparison against each live token. The set is tiny (one
			// per running job, and concurrency defaults to 2), and a plain Map lookup
			// would leak through timing which prefixes are close to a real token.
			const candidate = Buffer.from(token);
			for (const [known, jobId] of byToken) {
				const knownBuffer = Buffer.from(known);
				if (knownBuffer.length !== candidate.length) continue;
				if (timingSafeEqual(knownBuffer, candidate)) return jobId;
			}
			return undefined;
		},

		revoke(jobId) {
			const token = byJob.get(jobId);
			if (token) byToken.delete(token);
			byJob.delete(jobId);
		},

		size: () => byToken.size,
	};
}

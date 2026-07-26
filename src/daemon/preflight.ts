/**
 * Pre-spend gates. Pure function over injected dependencies —
 * that shape is deliberate, echoing pi-dispatch's processor.mjs:
 *   "so the money-safety ORDER can be tested without GitHub, Docker, or Redis"
 * The ORDER is the contract, and it can be tested end to end without spawning a
 * process or touching the network.
 *
 * Order (all strictly before spawn):
 *   1. provider credential present  -> missing means config_error
 *   2. git working tree clean       -> only when the trigger opts in
 *   3. budget window not exhausted  -> over cap means budget_exceeded
 *
 * Gate 2 defaults off on purpose. Refusing a dirty tree is right for
 * pi-dispatch, whose jobs are operator-initiated code changes. Ours are
 * unattended cron: a read-only daily report would refuse to run every night
 * because of uncommitted work, plus send a failure notification every night —
 * worse than the risk it prevents. Code-touching triggers opt in themselves.
 */
import type { AgentProfile } from "../core/config.ts";
import type { ProviderCredential } from "../core/credentials.ts";

export type RefusalReason = "config_error" | "budget_exceeded";

export type PreflightResult =
	| { ok: true; providerVars: Record<string, string> }
	| { ok: false; reason: RefusalReason; detail: string };

export interface PreflightDeps {
	/** Resolves the provider credential; undefined when unconfigured. */
	resolveProvider: (provider: string) => Promise<ProviderCredential | undefined>;
	/** Whether `git status --porcelain` produced output; null means not a usable repo. */
	isDirty: (cwd: string) => boolean | null;
	/** Tokens already spent today. */
	spentToday: () => number;
	/** Daily cap; null disables the gate. */
	dailyCap: number | null;
	/** Soft-limit ratio (0-1). Crossing it warns but never refuses — AWS Budgets alert semantics. */
	softLimitRatio?: number;
	/** Where the soft-limit warning goes; has no bearing on admission. */
	onSoftLimit?: (spent: number, cap: number) => void;
}

export interface PreflightInput {
	agent: AgentProfile;
	requireCleanTree: boolean;
}

export async function preflight(input: PreflightInput, deps: PreflightDeps): Promise<PreflightResult> {
	// ---- Gate 1: provider credential ------------------------------------
	// Measured: without this gate the job spawns and only `prompt` reports
	// "No API key found", wasting a concurrency slot and producing a failure
	// whose reason is ambiguous. Refusing here yields config_error (policy class,
	// never retried).
	const credential = await deps.resolveProvider(input.agent.provider);
	if (!credential || Object.keys(credential.vars).length === 0) {
		return {
			ok: false,
			reason: "config_error",
			detail: `no credential for provider "${input.agent.provider}" (agent ${input.agent.name})`,
		};
	}

	// ---- Gate 2: dirty tree (off by default, per-trigger opt-in) ---------
	if (input.requireCleanTree) {
		const dirty = deps.isDirty(input.agent.cwd);
		if (dirty === null) {
			return {
				ok: false,
				reason: "config_error",
				detail: `requireCleanTree is set but ${input.agent.cwd} is not a git repository`,
			};
		}
		if (dirty) {
			return { ok: false, reason: "config_error", detail: `working tree is dirty: ${input.agent.cwd}` };
		}
	}

	// ---- Gate 3: budget -------------------------------------------------
	// Last, because it is the only gate that consumes an allowance: a free
	// refusal from an earlier gate should not occupy a budget window.
	if (deps.dailyCap !== null) {
		const spent = deps.spentToday();
		if (spent >= deps.dailyCap) {
			return { ok: false, reason: "budget_exceeded", detail: `daily token cap reached (${spent}/${deps.dailyCap})` };
		}
		const ratio = deps.softLimitRatio;
		if (ratio !== undefined && ratio > 0 && spent >= deps.dailyCap * ratio) {
			// Warn, do not refuse: refusing at 80% is just a lower cap with extra steps.
			deps.onSoftLimit?.(spent, deps.dailyCap);
		}
	}

	return { ok: true, providerVars: credential.vars };
}

/** Default `git status --porcelain` check; an injection point so tests can fake it. */
export function makeGitDirtyCheck(
	exec: (cmd: string, args: string[], cwd: string) => string,
): (cwd: string) => boolean | null {
	return (cwd) => {
		try {
			return exec("git", ["status", "--porcelain"], cwd).trim().length > 0;
		} catch {
			return null;
		}
	};
}

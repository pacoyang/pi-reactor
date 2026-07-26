/**
 * Builds the exact environment a job process receives. Pure, and
 * its own module because this is a security boundary.
 *
 * The host environment is never passed through wholesale, for two reasons:
 *  1. Sink credentials must not reach the agent. Sending a message is only
 *     possible through `notify` on the socket, so the bot token is physically
 *     out of reach. Even a job that ingests a hostile issue body and gets
 *     prompt-injected can at most send extra messages through the proper channel.
 *  2. `ANTHROPIC_OAUTH_TOKEN` silently outranks `ANTHROPIC_API_KEY`, so one
 *     stray host variable would change whose quota every job spends, with no
 *     error and no log line.
 *
 * pi-dispatch isolates the same concern as env-allowlist.mjs and marks it a
 * BLOCKER-level constraint in its comments.
 */
import type { AgentProfile } from "../core/config.ts";

/** Always forwarded; pi will not start without them (measured minimum set). */
const BASE_PASSTHROUGH = ["PATH", "HOME"] as const;

/**
 * Forwarded when present, and nothing else.
 * `PI_CODING_AGENT_DIR` matters: without it the job looks for auth.json and
 * writes sessions somewhere other than where the daemon reads them.
 * TMPDIR/LANG affect child temp files and encoding; their absence causes
 * hard-to-diagnose failures on some systems.
 */
const CONDITIONAL_PASSTHROUGH = ["PI_CODING_AGENT_DIR", "TMPDIR", "LANG", "LC_ALL"] as const;

export interface BuildJobEnvInput {
	agent: AgentProfile;
	jobId: number;
	socketPath: string;
	/** Provider credential variables already resolved by credentials.ts. */
	providerVars: Record<string, string>;
	/**
	 * Per-job capability token. Presenting it is how a job identifies itself
	 * to `schedule.*`; see job-tokens.ts for what it is and is not worth.
	 */
	token?: string | undefined;
	/** Host environment; injected for tests. */
	hostEnv?: NodeJS.ProcessEnv;
}

/**
 * Returns the complete environment the job process gets. Later assignments win:
 * base, conditional, provider credentials, reactor's own, then the agent's.
 * The agent's `env` may override TMPDIR and friends, but cannot conjure a host
 * variable that is not on one of the lists above.
 */
export function buildJobEnv(input: BuildJobEnvInput): Record<string, string> {
	const host = input.hostEnv ?? process.env;
	const env: Record<string, string> = {};

	for (const key of BASE_PASSTHROUGH) {
		const v = host[key];
		if (v !== undefined) env[key] = v;
	}
	for (const key of CONDITIONAL_PASSTHROUGH) {
		const v = host[key];
		if (v !== undefined && v !== "") env[key] = v;
	}

	Object.assign(env, input.providerVars);

	env.PI_REACTOR_SOCKET = input.socketPath;
	env.PI_REACTOR_JOB_ID = String(input.jobId);
	if (input.token) env.PI_REACTOR_TOKEN = input.token;

	Object.assign(env, input.agent.env);

	return env;
}

/**
 * Reports sensitive variables that should not be in a job environment.
 *
 * `REACTOR_` is the sink-credential prefix (`REACTOR_TG_BOT_TOKEN`); our own two
 * variables are `PI_REACTOR_`-prefixed and so are not matched. Used by the tests
 * and by `doctor` to turn "sink credentials never reach the agent" from a comment
 * into a checkable fact.
 */
export function findLeakedSecrets(env: Record<string, string>, forbiddenPrefixes = ["REACTOR_"]): string[] {
	return Object.keys(env).filter((k) => forbiddenPrefixes.some((p) => k.startsWith(p)));
}

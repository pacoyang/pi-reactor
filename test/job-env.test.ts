import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJobEnv, findLeakedSecrets } from "../src/daemon/job-env.ts";
import { buildArgs } from "../src/daemon/agent-runner.ts";
import type { AgentProfile } from "../src/core/config.ts";

const AGENT: AgentProfile = {
	name: "report",
	cwd: "/tmp/project",
	provider: "anthropic",
	modelId: "claude-sonnet-5",
	extensions: [],
	env: {},
	maxDurationS: 1800,
};

/** A "dirty" host environment: sink credentials, a rival provider token, unrelated vars. */
const HOST: NodeJS.ProcessEnv = {
	PATH: "/usr/bin",
	HOME: "/home/paco",
	TMPDIR: "/tmp",
	LANG: "en_US.UTF-8",
	PI_CODING_AGENT_DIR: "/home/paco/.pi/agent",
	REACTOR_TG_TOKEN: "123456:AAF-secret",
	REACTOR_SLACK_WEBHOOK: "https://hooks.slack.com/secret",
	ANTHROPIC_OAUTH_TOKEN: "oauth-that-would-silently-outrank",
	AWS_SECRET_ACCESS_KEY: "unrelated",
	SSH_AUTH_SOCK: "/tmp/ssh",
};

test("sink credentials never reach the job environment: a security boundary, not a style choice", () => {
	const env = buildJobEnv({
		agent: AGENT, jobId: 42, socketPath: "/home/paco/.pi-reactor/daemon.sock",
		providerVars: { ANTHROPIC_API_KEY: "sk-chosen" }, hostEnv: HOST,
	});
	assert.equal(env.REACTOR_TG_TOKEN, undefined);
	assert.equal(env.REACTOR_SLACK_WEBHOOK, undefined);
	assert.deepEqual(findLeakedSecrets(env), [],
		"the agent can only send through notify on the socket; the bot token is physically out of reach");
});

test("no wholesale host env: a stray OAUTH_TOKEN must not change who pays", () => {
	const env = buildJobEnv({
		agent: AGENT, jobId: 1, socketPath: "/s",
		providerVars: { ANTHROPIC_API_KEY: "sk-chosen" }, hostEnv: HOST,
	});
	assert.equal(env.ANTHROPIC_API_KEY, "sk-chosen");
	assert.equal(env.ANTHROPIC_OAUTH_TOKEN, undefined,
		"findEnvKeys ranks OAUTH_TOKEN above API_KEY, so passing through would let a stray variable reassign the quota");
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(env.SSH_AUTH_SOCK, undefined);
});

test("allowlist: base, conditional passthrough, and reactor's own", () => {
	const env = buildJobEnv({
		agent: AGENT, jobId: 42, socketPath: "/sock", providerVars: {}, hostEnv: HOST,
	});
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.HOME, "/home/paco");
	assert.equal(env.TMPDIR, "/tmp");
	assert.equal(env.LANG, "en_US.UTF-8");
	assert.equal(env.PI_CODING_AGENT_DIR, "/home/paco/.pi/agent",
		"required, or the job reads auth.json and writes sessions somewhere the daemon does not look");
	assert.equal(env.PI_REACTOR_SOCKET, "/sock");
	assert.equal(env.PI_REACTOR_JOB_ID, "42");
});

test("absent conditional variables leave no empty keys", () => {
	const env = buildJobEnv({
		agent: AGENT, jobId: 1, socketPath: "/s", providerVars: {},
		hostEnv: { PATH: "/usr/bin", HOME: "/h", TMPDIR: "" },
	});
	assert.ok(!("TMPDIR" in env), "an empty string counts as unset");
	assert.ok(!("LANG" in env));
});

test("agent.env may override but cannot conjure an unlisted host variable", () => {
	const agent: AgentProfile = { ...AGENT, env: { TMPDIR: "/custom/tmp", MY_FLAG: "1" } };
	const env = buildJobEnv({ agent, jobId: 1, socketPath: "/s", providerVars: {}, hostEnv: HOST });
	assert.equal(env.TMPDIR, "/custom/tmp");
	assert.equal(env.MY_FLAG, "1");
	assert.equal(env.SSH_AUTH_SOCK, undefined, "the ability to override is not the ability to escalate");
});

test("buildArgs: -ne always, then each allowlisted extension via -e", () => {
	assert.deepEqual(buildArgs(AGENT, "/rpc-entry.js"),
		["/rpc-entry.js", "-ne", "--provider", "anthropic", "--model", "claude-sonnet-5"]);

	const withExt: AgentProfile = { ...AGENT, extensions: ["/ext/sub2api.ts"], thinkingLevel: "medium" };
	assert.deepEqual(buildArgs(withExt, "/rpc-entry.js"), [
		"/rpc-entry.js", "-ne", "-e", "/ext/sub2api.ts",
		"--provider", "anthropic", "--model", "claude-sonnet-5", "--thinking", "medium",
	]);
});

test("findLeakedSecrets allows reactor's own two variables", () => {
	assert.deepEqual(findLeakedSecrets({ PI_REACTOR_SOCKET: "/s", PI_REACTOR_JOB_ID: "1" }), []);
	assert.deepEqual(findLeakedSecrets({ REACTOR_TG_TOKEN: "x" }), ["REACTOR_TG_TOKEN"]);
});

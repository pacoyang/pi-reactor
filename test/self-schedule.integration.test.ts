/**
 * Agent self-scheduling, and its gate.
 *
 * The gate is the point, not the feature. An agent that can create schedules
 * fails by creating a hundred of them, and by creating ones nobody can tell
 * apart from what a human asked for — so what is tested here is mostly what the
 * daemon REFUSES.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, type Paths } from "../src/core/paths.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { serve } from "../src/daemon/serve.ts";
import { callDaemon, DaemonCallError } from "../src/core/rpc-client.ts";
import { createJobTokens } from "../src/daemon/job-tokens.ts";
import { RPC_ERRORS } from "../src/core/rpc-types.ts";

const quiet = createLogger({ level: "error", write: () => {} });

interface Fixture {
	paths: Paths;
	cwd: string;
	cleanup(): void;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-selfsched-"));
	const dir = join(root, "reactor");
	const cwd = join(root, "work");
	mkdirSync(dir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const paths = resolvePaths({ PI_REACTOR_DIR: dir });
	writeFileSync(paths.agentsFile, JSON.stringify({ agents: { report: { cwd, model: "stub/model" } } }));
	return { paths, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A daemon plus a token for a pretend running job. */
async function withJob(
	f: Fixture,
	fn: (call: Call, token: string, tokens: ReturnType<typeof createJobTokens>) => Promise<void>,
	quota = 5,
): Promise<void> {
	// The registry is shared with the daemon, which is how a real job gets its
	// token: the worker mints on spawn and revokes on settle.
	const tokens = createJobTokens();
	const daemon = await serve({
		paths: f.paths,
		logger: quiet,
		installSignalHandlers: false,
		aiScheduleQuota: quota,
		jobTokens: tokens,
	});
	const call: Call = (method, params) => callDaemon({ socketPath: f.paths.sock }, method, params);
	try {
		await fn(call, tokens.issue(1), tokens);
	} finally {
		await daemon.stop();
	}
}

type Call = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function scheduleParams(id: string, token: string): Record<string, unknown> {
	return { token, id, schedule: "0 9 * * *", agent: "report", task: "summarise yesterday" };
}

test("a job can schedule itself, and what it writes says so", async () => {
	const f = fixture();
	try {
		await withJob(f, async (call, token) => {
			await call("schedule.add", scheduleParams("agent-made", token));

			const written = JSON.parse(readFileSync(f.paths.triggersFile, "utf8")) as {
				triggers: Array<{ on: { id: string }; aiAuthored?: boolean }>;
			};
			assert.equal(written.triggers.length, 1);
			assert.equal(written.triggers[0]?.aiAuthored, true,
				"recorded in the file, so a human reading it later can tell what an agent asked for");

			const listed = (await call("schedule.ls")) as { schedules: Array<{ id: string }> };
			assert.equal(listed.schedules.length, 1, "and it is armed, without a restart");
		});
	} finally {
		f.cleanup();
	}
});

test("without a valid job token there is no self-scheduling at all", async () => {
	const f = fixture();
	try {
		await withJob(f, async (call, token, tokens) => {
			const refused = async (params: Record<string, unknown>, why: string): Promise<void> => {
				const err = await call("schedule.add", params).then(() => null, (e: Error) => e);
				assert.ok(err instanceof DaemonCallError, why);
				assert.equal(err.code, RPC_ERRORS.FORBIDDEN, why);
			};

			await refused({ ...scheduleParams("no-token", token), token: undefined }, "no token");
			await refused({ ...scheduleParams("bad-token", token), token: "not-a-real-token" }, "forged token");

			// A token dies with its job, so a finished run cannot keep scheduling.
			tokens.revoke(1);
			await refused(scheduleParams("stale-token", token), "revoked token");

			assert.equal(existsSync(f.paths.triggersFile), false,
				"not one of those refusals may have written anything");
		});
	} finally {
		f.cleanup();
	}
});

test("the quota bounds how many schedules an agent can accumulate", async () => {
	const f = fixture();
	try {
		await withJob(
			f,
			async (call, token) => {
				await call("schedule.add", scheduleParams("first", token));
				await call("schedule.add", scheduleParams("second", token));

				const err = await call("schedule.add", scheduleParams("third", token)).then(() => null, (e: Error) => e);
				assert.ok(err instanceof DaemonCallError);
				assert.equal(err.code, RPC_ERRORS.FORBIDDEN);
				assert.match(err.message, /quota reached \(2\/2\)/,
					"an agent with a scheduler fails by making a hundred, not one");
			},
			2,
		);
	} finally {
		f.cleanup();
	}
});

test("a job may withdraw its own schedule, but not the operator's", async () => {
	const f = fixture();
	try {
		await withJob(f, async (call, token) => {
			// One the operator created, through the ordinary door.
			await call("trigger.add", {
				trigger: { on: { type: "cron", id: "human-made", schedule: "0 8 * * *" }, run: { agent: "report", task: "t" } },
			});
			await call("schedule.add", scheduleParams("agent-made", token));

			await call("schedule.rm", { token, id: "agent-made" });
			assert.equal(readFileSync(f.paths.triggersFile, "utf8").includes("agent-made"), false);

			const err = await call("schedule.rm", { token, id: "human-made" }).then(() => null, (e: Error) => e);
			assert.ok(err instanceof DaemonCallError);
			assert.equal(err.code, RPC_ERRORS.FORBIDDEN);
			assert.match(err.message, /not created by an agent/);
			assert.ok(readFileSync(f.paths.triggersFile, "utf8").includes("human-made"));
		});
	} finally {
		f.cleanup();
	}
});

test("self-scheduling gets the same validation as anything else", async () => {
	const f = fixture();
	try {
		await withJob(f, async (call, token) => {
			for (const [params, expected] of [
				[{ ...scheduleParams("bad-cron", token), schedule: "77 * * * *" }, /Invalid value for minute/],
				[{ ...scheduleParams("ghost", token), agent: "nobody" }, /unknown agent/],
				[{ token, id: "no-work", schedule: "0 9 * * *", agent: "report" }, /needs a task or a skill/],
			] as const) {
				const err = await call("schedule.add", params).then(() => null, (e: Error) => e);
				assert.ok(err instanceof DaemonCallError, JSON.stringify(params));
				assert.match(err.message, expected);
			}
		});
	} finally {
		f.cleanup();
	}
});

// ---------------------------------------------------------------- unit

test("tokens are unguessable, single-use per job, and die on revoke", () => {
	const tokens = createJobTokens();

	const a = tokens.issue(1);
	const b = tokens.issue(2);
	assert.notEqual(a, b);
	assert.ok(a.length >= 32, "24 random bytes, base64url");
	assert.equal(tokens.resolve(a), 1);
	assert.equal(tokens.resolve(b), 2);
	assert.equal(tokens.resolve("nonsense"), undefined);
	assert.equal(tokens.resolve(""), undefined);

	// Re-issuing replaces: a retried job is the same job, and the old token must
	// not outlive the process it was minted for.
	const a2 = tokens.issue(1);
	assert.notEqual(a2, a);
	assert.equal(tokens.resolve(a), undefined);
	assert.equal(tokens.resolve(a2), 1);

	tokens.revoke(1);
	assert.equal(tokens.resolve(a2), undefined);
	assert.equal(tokens.size(), 1, "revoking one job leaves the other alone");
});

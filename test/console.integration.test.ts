/**
 * Conversational configuration, over the same socket the operator console uses.
 *
 * The load-bearing claim: you can install the daemon, start it with nothing
 * configured, and describe what you want — validated, previewed, written, live,
 * no restart. Plus the diff the confirmation gate shows, because a gate nobody
 * can read is not a gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, type Paths } from "../src/core/paths.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { serve, type RunningDaemon } from "../src/daemon/serve.ts";
import { callDaemon, DaemonCallError, DaemonUnavailableError } from "../src/core/rpc-client.ts";
import { diffLines } from "../src/extension/index.ts";

const quiet = createLogger({ level: "error", write: () => {} });

interface Fixture {
	paths: Paths;
	cwd: string;
	cleanup(): void;
}

/** A freshly installed daemon directory: no agents.json, no sinks.json, nothing. */
function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-console-"));
	const dir = join(root, "reactor");
	const cwd = join(root, "work");
	mkdirSync(dir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { paths: resolvePaths({ PI_REACTOR_DIR: dir }), cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function withDaemon(f: Fixture, fn: (call: Call) => Promise<void>): Promise<void> {
	const daemon: RunningDaemon = await serve({ paths: f.paths, logger: quiet, installSignalHandlers: false });
	const call: Call = (method, params) => callDaemon({ socketPath: f.paths.sock }, method, params);
	try {
		await fn(call);
	} finally {
		await daemon.stop();
	}
}

type Call = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

interface ChangeResult {
	before: string;
	after: string;
	changed: boolean;
	applied: boolean;
	file: string;
}

test("a daemon with nothing configured starts, and is configured through itself", async () => {
	// The bootstrap that conversational config needs, and that the old loader made impossible: it
	// refused to start without at least one agent, so the conversational path had
	// no first step.
	const f = fixture();
	try {
		await withDaemon(f, async (call) => {
			assert.deepEqual((await call("agent.ls")) as unknown, { agents: [] });

			await call("agent.add", { name: "report", agent: { cwd: f.cwd, model: "stub/model" } });
			await call("sink.add", { name: "tg", sink: { kind: "telegram", chatId: 4242 } });
			await call("credential.set", { name: "tg", field: "botToken", value: "123:SECRET" });
			await call("trigger.add", {
				trigger: {
					on: { type: "cron", id: "nightly", schedule: "0 9 * * *", timezone: "Asia/Shanghai" },
					run: { agent: "report", task: "yesterday's digest" },
					notify: { sink: "tg", when: "always" },
				},
			});

			// Live immediately: the scheduler armed it without a restart.
			const schedules = (await call("schedule.ls")) as { schedules: Array<{ id: string; configured: boolean }> };
			assert.equal(schedules.schedules.length, 1);
			assert.equal(schedules.schedules[0]?.id, "nightly");
			assert.equal(schedules.schedules[0]?.configured, true);

			const status = (await call("status")) as { agents: string[] };
			assert.deepEqual(status.agents, ["report"]);
		});
	} finally {
		f.cleanup();
	}
});

test("a dry run returns a validated before/after and writes nothing", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async (call) => {
			await call("agent.add", { name: "report", agent: { cwd: f.cwd, model: "stub/model" } });

			const preview = (await call("trigger.add", {
				dryRun: true,
				trigger: { on: { type: "cron", id: "nightly", schedule: "0 9 * * *" }, run: { agent: "report", task: "t" } },
			})) as ChangeResult;

			assert.equal(preview.applied, false);
			assert.equal(preview.changed, true);
			assert.match(preview.after, /nightly/);
			assert.equal(existsSync(f.paths.triggersFile), false,
				"what the operator approves must be validated, and approving it must still be their choice");
		});
	} finally {
		f.cleanup();
	}
});

test("a refused change comes back as invalid params, with the reason, changing nothing", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async (call) => {
			await call("agent.add", { name: "report", agent: { cwd: f.cwd, model: "stub/model" } });

			for (const [trigger, expected] of [
				[{ on: { type: "cron", id: "a", schedule: "77 * * * *" }, run: { agent: "report", task: "t" } }, /Invalid value for minute/],
				[{ on: { type: "cron", id: "b", schedule: "0 9 * * *" }, run: { agent: "ghost", task: "t" } }, /ghost/],
				[{ on: { type: "cron", id: "c", schedule: "0 9 * * *" }, run: { agent: "report", task: "t" }, notify: { sink: "nope" } }, /nope/],
			] as const) {
				const err = await call("trigger.add", { trigger }).then(() => null, (e: Error) => e);
				assert.ok(err instanceof DaemonCallError, "a caller's mistake, not an internal error");
				assert.equal(err.code, -32602);
				assert.match(err.message, expected);
			}
			assert.equal(existsSync(f.paths.triggersFile), false);
		});
	} finally {
		f.cleanup();
	}
});

test("sink.ls names which credentials exist and never their values", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async (call) => {
			await call("sink.add", { name: "tg", sink: { kind: "telegram", chatId: 7 } });
			await call("credential.set", { name: "tg", field: "botToken", value: "123:SECRET" });

			const listed = (await call("sink.ls")) as { sinks: Array<{ name: string; credentials: string[] }> };
			assert.deepEqual(listed.sinks[0]?.credentials, ["botToken"]);
			assert.doesNotMatch(JSON.stringify(listed), /SECRET/,
				"the console feeds this to a model; the token must never be in it");
			assert.doesNotMatch(readFileSync(f.paths.sinksFile, "utf8"), /SECRET/,
				"and the config file stays showable in full by the confirmation gate");
		});
	} finally {
		f.cleanup();
	}
});

test("the console reports a missing daemon as such, rather than hanging", async () => {
	const f = fixture();
	try {
		await assert.rejects(
			() => callDaemon({ socketPath: f.paths.sock }, "status"),
			(err: unknown) => err instanceof DaemonUnavailableError && /not running/.test((err as Error).message),
		);
	} finally {
		f.cleanup();
	}
});

test("the confirmation gate shows the lines that moved, not both documents in full", () => {
	// A triggers.json with a dozen entries would bury the one line that changed,
	// and a gate nobody reads is not a gate.
	const before = ["{", '\t"triggers": [', "\t\t{", '\t\t\t"schedule": "0 9 * * *"', "\t\t}", "\t]", "}"].join("\n");
	const after = before.replace("0 9 * * *", "0 10 * * *");

	const diff = diffLines(before, after);
	assert.match(diff, /^- .*0 9 \* \* \*/m);
	assert.match(diff, /^\+ .*0 10 \* \* \*/m);
	assert.doesNotMatch(diff, /^[-+].*triggers/m, "unchanged lines are context, not changes");

	assert.equal(diffLines("same", "same"), "(no textual change)");
	assert.match(diffLines("a\nb", "a\nb\nc"), /^\+ c$/m);
});

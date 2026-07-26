import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgents, parseSinks, parseTriggers, loadConfig, ConfigError, type AgentProfile, type SinkSpec } from "../src/core/config.ts";
import { resolvePaths } from "../src/core/paths.ts";

/** Creates a temp workspace so agent.cwd existence checks have something real. */
function tmpWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-reactor-cfg-"));
	mkdirSync(join(dir, "project"), { recursive: true });
	return dir;
}

const AGENTS = (cwd: string) => ({ agents: { report: { cwd, model: "anthropic/claude-sonnet-5" } } });

test("parseAgents: splits provider/modelId, empty extension allowlist by default", () => {
	const base = tmpWorkspace();
	try {
		const cwd = join(base, "project");
		const agents = parseAgents(AGENTS(cwd), "agents.json");
		const report = agents.report as AgentProfile;
		assert.equal(report.provider, "anthropic");
		assert.equal(report.modelId, "claude-sonnet-5");
		assert.deepEqual(report.extensions, [], "no extensions by default: global ones were measured polluting a batch job");
		assert.equal(report.maxDurationS, 1800);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("parseAgents: each fail-loud case", () => {
	const base = tmpWorkspace();
	try {
		const cwd = join(base, "project");
		const cases: Array<[string, unknown]> = [
			["missing agents key", {}],
			["invalid agent name", { agents: { "Bad Name": { cwd, model: "a/b" } } }],
			["cwd does not exist", { agents: { r: { cwd: join(base, "nope"), model: "a/b" } } }],
			["cwd is a file, not a directory", { agents: { r: { cwd: join(base, "file.txt"), model: "a/b" } } }],
			["model has no slash", { agents: { r: { cwd, model: "sonnet" } } }],
			["model starts with a slash", { agents: { r: { cwd, model: "/sonnet" } } }],
			["model ends with a slash", { agents: { r: { cwd, model: "anthropic/" } } }],
			["extensions is not an array", { agents: { r: { cwd, model: "a/b", extensions: "x" } } }],
			["env value is not a string", { agents: { r: { cwd, model: "a/b", env: { K: 1 } } } }],
			["invalid maxDuration", { agents: { r: { cwd, model: "a/b", maxDuration: "soon" } } }],
		];
		writeFileSync(join(base, "file.txt"), "");
		for (const [label, raw] of cases) {
			assert.throws(() => parseAgents(raw, "agents.json"), (e: unknown) => e instanceof Error && /Config|Duration/.test(e.name), label);
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("parseSinks: telegram needs an integer chatId and carries no credential field", () => {
	const sinks = parseSinks({ sinks: { tg: { kind: "telegram", chatId: 123456 } } }, "sinks.json");
	const tg = sinks.tg as SinkSpec;
	assert.equal(tg.kind, "telegram");
	assert.equal(tg.chatId, 123456);
	assert.ok(!("botToken" in tg), "credential values never enter config; they live in credentials.json");

	assert.throws(() => parseSinks({ sinks: { tg: { kind: "telegram" } } }, "s"), ConfigError, "missing chatId");
	assert.throws(() => parseSinks({ sinks: { tg: { kind: "telegram", chatId: "123" } } }, "s"), ConfigError, "chatId is not an integer");
	assert.throws(() => parseSinks({ sinks: { x: { kind: "carrier-pigeon" } } }, "s"), ConfigError, "unknown kind");
});

test("parseTriggers: cron expression and timezone are validated at load, not at 3am", () => {
	const base = tmpWorkspace();
	try {
		const cwd = join(base, "project");
		const agents = parseAgents(AGENTS(cwd), "a");
		const sinks = parseSinks({ sinks: { tg: { kind: "telegram", chatId: 1 } } }, "s");
		const ok = parseTriggers({
			triggers: [{
				on: { type: "cron", id: "nightly", schedule: "0 9 * * *", timezone: "Asia/Shanghai", misfirePolicy: "fireOnce" },
				run: { agent: "report", task: "summarise" },
				notify: { sink: "tg", when: "always" },
			}],
		}, "t", agents, sinks);
		assert.equal(ok.length, 1);
		assert.equal(ok[0]?.kind, "cron");
		assert.equal(ok[0]?.run.retryable, true, "retryable by default");
		assert.equal(ok[0]?.run.requireCleanTree, false, "dirty-tree check defaults off: refusing by default is wrong for unattended runs");

		const bad = (on: unknown, run: unknown = { agent: "report", task: "t" }) =>
			() => parseTriggers({ triggers: [{ on, run }] }, "t", agents, sinks);

		assert.throws(bad({ type: "cron", id: "x", schedule: "not a cron" }), ConfigError, "invalid cron expression");
		assert.throws(bad({ type: "cron", id: "x", schedule: "0 9 * * *", timezone: "Mars/Olympus" }), ConfigError,
			"invalid timezone: croner does not validate it at construction, only nextRun() reveals it");
		assert.throws(bad({ type: "cron", id: "x", schedule: "0 0 30 2 *" }), ConfigError,
			"Feb 30: croner accepts it but nextRun() is null, i.e. it never fires; must be caught at load");
		assert.throws(bad({ type: "cron", id: "x", schedule: "0 9 * * *", misfirePolicy: "retry" }), ConfigError, "invalid misfirePolicy");
		assert.throws(bad({ type: "smoke-signal", id: "x" }), ConfigError, "unknown trigger type");
		assert.throws(bad({ type: "cron", id: "x", schedule: "0 9 * * *" }, { agent: "ghost", task: "t" }), ConfigError, "points at an undefined agent");
		assert.throws(bad({ type: "cron", id: "x", schedule: "0 9 * * *" }, { agent: "report" }), ConfigError, "neither task nor skill");

		assert.throws(
			() => parseTriggers({
				triggers: [{ on: { type: "cron", id: "x", schedule: "0 9 * * *" }, run: { agent: "report", task: "t" }, notify: { sink: "ghost" } }],
			}, "t", agents, sinks),
			ConfigError, "notify.sink is not registered",
		);
		assert.throws(
			() => parseTriggers({
				triggers: [
					{ on: { type: "cron", id: "dup", schedule: "0 9 * * *" }, run: { agent: "report", task: "t" } },
					{ on: { type: "cron", id: "dup", schedule: "0 10 * * *" }, run: { agent: "report", task: "t" } },
				],
			}, "t", agents, sinks),
			ConfigError, "duplicate trigger id: it forms half the CloudEvents source and must be unique",
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("loadConfig: absent files mean an empty configuration; a present but invalid one is fatal", () => {
	const base = tmpWorkspace();
	try {
		const cwd = join(base, "project");
		const root = join(base, "cfg");
		mkdirSync(root, { recursive: true });
		const paths = resolvePaths({ PI_REACTOR_DIR: root });

		// A daemon with nothing configured is the state a fresh install starts in.
		// Refusing to run until a file exists made the conversational path
		// impossible to bootstrap: you cannot configure through a daemon that will
		// not start until it is configured.
		const empty = loadConfig(paths);
		assert.deepEqual(empty, { agents: {}, sinks: {}, triggers: [] });

		writeFileSync(paths.agentsFile, "{ not json");
		assert.throws(() => loadConfig(paths), ConfigError, "present but broken is still fatal");

		writeFileSync(paths.agentsFile, JSON.stringify(AGENTS(cwd)));
		const cfg = loadConfig(paths);
		assert.deepEqual(cfg.triggers, [], "runs without triggers.json before the scheduler exists (emit only)");
		assert.deepEqual(cfg.sinks, {});

		writeFileSync(paths.agentsFile, "{ not json");
		assert.throws(() => loadConfig(paths), ConfigError, "malformed JSON must name the file");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

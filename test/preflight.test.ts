import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, type PreflightDeps } from "../src/daemon/preflight.ts";
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

/** Records the order gates were called in: the ORDER is the contract, which is
 *  exactly what a pure function over injected dependencies exists to protect. */
function makeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps & { calls: string[] } {
	const calls: string[] = [];
	const deps: PreflightDeps & { calls: string[] } = {
		calls,
		resolveProvider: async (p) => {
			calls.push("provider");
			return { vars: { ANTHROPIC_API_KEY: "sk-test" }, source: "env" as const };
		},
		isDirty: () => {
			calls.push("dirty");
			return false;
		},
		spentToday: () => {
			calls.push("budget");
			return 0;
		},
		dailyCap: 500_000,
		...overrides,
	};
	return deps;
}

test("all gates pass: returns providerVars for job-env", async () => {
	const deps = makeDeps();
	const r = await preflight({ agent: AGENT, requireCleanTree: false }, deps);
	assert.equal(r.ok, true);
	if (r.ok) assert.deepEqual(r.providerVars, { ANTHROPIC_API_KEY: "sk-test" });
});

test("gate order: credential, dirty tree, budget (and the tree check is skipped by default)", async () => {
	const deps = makeDeps();
	await preflight({ agent: AGENT, requireCleanTree: false }, deps);
	assert.deepEqual(deps.calls, ["provider", "budget"], "git must not be touched unless requireCleanTree is set");

	const withTree = makeDeps();
	await preflight({ agent: AGENT, requireCleanTree: true }, withTree);
	assert.deepEqual(withTree.calls, ["provider", "dirty", "budget"]);
});

test("a missing credential yields config_error and stops there, without consuming a budget window", async () => {
	const deps = makeDeps({ resolveProvider: async () => undefined });
	const r = await preflight({ agent: AGENT, requireCleanTree: true }, deps);
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.reason, "config_error");
		assert.match(r.detail, /anthropic/);
	}
	assert.ok(!deps.calls.includes("budget"), "a free refusal should not consume the budget check");
});

test("empty vars counts as a missing credential", async () => {
	const deps = makeDeps({ resolveProvider: async () => ({ vars: {}, source: "env" as const }) });
	const r = await preflight({ agent: AGENT, requireCleanTree: false }, deps);
	assert.equal(r.ok, false);
});

test("dirty tree refuses only when opted in: refusing by default is wrong for unattended runs", async () => {
	const dirty = makeDeps({ isDirty: () => true });
	const off = await preflight({ agent: AGENT, requireCleanTree: false }, dirty);
	assert.equal(off.ok, true, "a read-only daily report should not fail nightly because of uncommitted work");

	const on = await preflight({ agent: AGENT, requireCleanTree: true }, makeDeps({ isDirty: () => true }));
	assert.equal(on.ok, false);
	if (!on.ok) assert.equal(on.reason, "config_error");
});

test("requireCleanTree on a non-repo is refused rather than silently allowed", async () => {
	const r = await preflight({ agent: AGENT, requireCleanTree: true }, makeDeps({ isDirty: () => null }));
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.detail, /not a git repository/);
});

test("budget: at the cap it refuses; with no cap it admits", async () => {
	const over = await preflight({ agent: AGENT, requireCleanTree: false }, makeDeps({ spentToday: () => 500_000 }));
	assert.equal(over.ok, false);
	if (!over.ok) assert.equal(over.reason, "budget_exceeded");

	const uncapped = await preflight({ agent: AGENT, requireCleanTree: false }, makeDeps({ dailyCap: null, spentToday: () => 9_999_999 }));
	assert.equal(uncapped.ok, true);
});

test("the soft limit warns and never refuses (AWS alert-threshold semantics)", async () => {
	const warned: Array<[number, number]> = [];
	const r = await preflight({ agent: AGENT, requireCleanTree: false }, makeDeps({
		spentToday: () => 400_000,
		softLimitRatio: 0.8,
		onSoftLimit: (spent, cap) => warned.push([spent, cap]),
	}));
	assert.equal(r.ok, true, "refusing at 80% is just a lower cap with extra steps");
	assert.deepEqual(warned, [[400_000, 500_000]]);

	const below = await preflight({ agent: AGENT, requireCleanTree: false }, makeDeps({
		spentToday: () => 100_000, softLimitRatio: 0.8, onSoftLimit: () => warned.push([0, 0]),
	}));
	assert.equal(below.ok, true);
	assert.equal(warned.length, 1, "no warning below the threshold");
});

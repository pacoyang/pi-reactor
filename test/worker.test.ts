/**
 * Worker behaviour driven against a stub RPC agent: per-agent serialisation,
 * the timeout chain, and the terminal transaction's shape.
 *
 * These are the two claims that need a live child process but not
 * a live model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/daemon/agent-runner.ts";
import { buildJobEnv } from "../src/daemon/job-env.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { classify } from "../src/daemon/outcome.ts";
import { openDb } from "../src/core/db.ts";
import { enqueue, claimNextJob, finishJob, locateSessions, markInterrupted, recordRunStart, tokensSpentToday, queueCounts } from "../src/daemon/store.ts";
import { cliEvent } from "../src/core/cloudevents.ts";
import type { AgentProfile } from "../src/core/config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "fixtures/stub-agent.mjs");
const quiet = createLogger({ level: "error", write: () => {} });

function tmpWorkspace(): { cwd: string; cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-worker-"));
	const cwd = join(root, "work");
	mkdirSync(cwd, { recursive: true });
	return { cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Stub configuration travels through `agent.env`, not the host environment:
 * buildJobEnv's allowlist deliberately drops unknown host variables, which this
 * indirection also demonstrates.
 */
function agentFor(cwd: string, env: Record<string, string> = {}): AgentProfile {
	return { name: "stub", cwd, provider: "stub", modelId: "model", extensions: [], env, maxDurationS: 60 };
}

test("a normal run settles, reports usage, and captures the session file", async () => {
	const ws = tmpWorkspace();
	try {
		const agent = agentFor(ws.cwd, { STUB_WORK_MS: "30", STUB_TEXT: "all done", STUB_TOKENS: "250" });
		const result = await runAgent({
			agent,
			task: "do the thing",
			env: buildJobEnv({ agent, jobId: 1, socketPath: "/tmp/x", providerVars: {} }),
			maxDurationMs: 10_000,
			logger: quiet,
			rpcEntry: STUB,
			startupProbeMs: 5000,
		});

		assert.equal(result.settled, true);
		assert.equal(result.lastText, "all done");
		assert.equal(result.usage.total, 250);
		assert.equal(result.sessionFile, "/tmp/stub-session.jsonl",
			"the reaper needs this path to delete only sessions we created");
		assert.equal(result.timedOut, false);
		assert.equal(classify(result).outcome, "succeeded");
	} finally {
		ws.cleanup();
	}
});

test("a hung run drives the full termination chain to failed + reason:timeout", async () => {
	const ws = tmpWorkspace();
	try {
		const agent = agentFor(ws.cwd, { STUB_HANG: "1" });
		const began = Date.now();
		const result = await runAgent({
			agent,
			task: "hang forever",
			env: buildJobEnv({ agent, jobId: 2, socketPath: "/tmp/x", providerVars: {} }),
			maxDurationMs: 300,
			logger: quiet,
			rpcEntry: STUB,
			startupProbeMs: 5000,
			abortGraceMs: 200,
			termGraceMs: 200,
		});
		const elapsed = Date.now() - began;

		assert.equal(result.timedOut, true);
		assert.equal(result.settled, false);
		const c = classify(result);
		assert.equal(c.outcome, "failed");
		assert.equal(c.reason, "timeout");
		assert.equal(c.retryable, false, "policy class: retrying without raising maxDuration spends the same money");
		assert.ok(elapsed < 5000, `the chain must not stall; took ${elapsed}ms`);
	} finally {
		ws.cleanup();
	}
});

test("a run whose agent leaves a background process behind still finishes", async () => {
	// The regression this pins: `exited` used to resolve on `close`, and `close`
	// waits for EVERY holder of the stdio pipes. An agent that ran `npm run dev &`
	// left a grandchild holding stdout, so the promise never resolved, the job
	// never settled, and its concurrency slot leaked until the daemon restarted.
	// Measured: the child emits `exit` in ~19ms and `close` never.
	const ws = tmpWorkspace();
	try {
		const agent = agentFor(ws.cwd, { STUB_WORK_MS: "20", STUB_TEXT: "deployed", STUB_LEAK_MS: "10000" });
		const began = Date.now();
		const result = await runAgent({
			agent,
			task: "start the dev server",
			env: buildJobEnv({ agent, jobId: 3, socketPath: "/tmp/x", providerVars: {} }),
			maxDurationMs: 10_000,
			logger: quiet,
			rpcEntry: STUB,
			startupProbeMs: 5000,
		});
		const elapsed = Date.now() - began;

		assert.equal(result.settled, true);
		assert.equal(result.lastText, "deployed", "the last frames must still be parsed before we call it done");
		assert.equal(classify(result).outcome, "succeeded");
		assert.ok(elapsed < 8000, `must not wait on the orphan's lifetime; took ${elapsed}ms`);
	} finally {
		ws.cleanup();
	}
});

test("whoever settles a job first owns its verdict", () => {
	// The shutdown race: a drain that times out marks its lingering jobs
	// interrupted and queues the obituaries, then a job finishes a beat later.
	// Ungated, it flipped the state back, wrote a second run and sent a second,
	// contradicting notification for the same job — measured before the guard.
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-settle-"));
	try {
		const db = openDb(join(root, "state.db"));
		enqueue(db, {
			event: cliEvent("j1"), lane: "batch", agent: "a", task: "t",
			maxDurationS: 60, requireCleanTree: false, retryable: true,
			notify: { sink: "tg", when: "always" },
		});
		const job = claimNextJob(db, 2);
		assert.ok(job);

		const interrupted = markInterrupted(db);
		assert.deepEqual(interrupted, { jobIds: [job.id], notified: 1 });

		const late = finishJob(db, {
			jobId: job.id, runId: job.runId, outcome: "succeeded",
			notify: { sink: "tg", body: "✅ all good" },
		});

		assert.equal(late.alreadySettled, true);
		assert.equal(late.runId, null);
		assert.equal(
			(db.prepare("SELECT state FROM jobs WHERE id = ?").get(job.id) as { state: string }).state,
			"interrupted",
			"a terminal state must not be walked back by a straggler",
		);
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1);
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n, 1,
			"two notifications contradicting each other is worse than one that is merely uncertain");
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the claim gate serialises jobs for the same agent", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-claim-"));
	try {
		const db = openDb(join(root, "state.db"));
		const base = {
			lane: "batch" as const,
			maxDurationS: 60,
			requireCleanTree: false,
			retryable: true,
		};
		for (let i = 0; i < 3; i++) {
			enqueue(db, { ...base, event: cliEvent(`same-agent-${i}`), agent: "report", task: `t${i}` });
		}
		enqueue(db, { ...base, event: cliEvent("other-agent"), agent: "other", task: "t" });

		const first = claimNextJob(db, 4);
		assert.equal(first?.agent, "report");

		const second = claimNextJob(db, 4);
		assert.equal(second?.agent, "other",
			"a second job for the same agent must wait: same cwd means concurrent writes would collide");

		const third = claimNextJob(db, 4);
		assert.equal(third, null, "both agents are busy, so nothing else is claimable");

		// Finishing the first frees that agent.
		finishJob(db, { jobId: first!.id, runId: first!.runId, outcome: "succeeded" });
		const fourth = claimNextJob(db, 4);
		assert.equal(fourth?.agent, "report");
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the global concurrency limit caps claims across agents", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-conc-"));
	try {
		const db = openDb(join(root, "state.db"));
		for (const name of ["a", "b", "c"]) {
			enqueue(db, {
				event: cliEvent(`agent-${name}`), lane: "batch", agent: name, task: "t",
				maxDurationS: 60, requireCleanTree: false, retryable: true,
			});
		}
		assert.ok(claimNextJob(db, 2));
		assert.ok(claimNextJob(db, 2));
		assert.equal(claimNextJob(db, 2), null, "the third is blocked by the global limit, not by agent identity");
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the terminal transaction writes job, run and outbox together", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-finish-"));
	try {
		const db = openDb(join(root, "state.db"));
		const { jobId } = enqueue(db, {
			event: cliEvent("finish-me"), lane: "batch", agent: "report", task: "t",
			maxDurationS: 60, requireCleanTree: false, retryable: true,
			notify: { sink: "tg", when: "always" },
		});
		const claimed = claimNextJob(db, 2);

		const { runId, outboxId } = finishJob(db, {
			jobId: jobId!,
			runId: claimed!.runId,
			outcome: "succeeded",
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
			notify: { sink: "tg", body: "done" },
		});

		const job = db.prepare("SELECT state, attempts FROM jobs WHERE id = ?").get(jobId!) as {
			state: string; attempts: number;
		};
		assert.equal(job.state, "succeeded");
		assert.equal(job.attempts, 1);

		const outbox = db.prepare("SELECT run_id, body, state FROM outbox WHERE id = ?").get(outboxId!) as {
			run_id: number; body: string; state: string;
		};
		assert.equal(outbox.run_id, runId, "the notification is linked to its run");
		assert.equal(outbox.body, "done");
		assert.equal(outbox.state, "pending");

		const runBody = db.prepare("SELECT total_tokens FROM runs WHERE id = ?").get(runId) as { total_tokens: number };
		assert.equal(runBody.total_tokens, 30);
		assert.equal(tokensSpentToday(db), 30, "the budget gate reads exactly this");
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a session pi wrote outside the default directory is still locatable", () => {
	// pi honours `sessionDir` from its settings (main.js:450-453), and those
	// settings are cwd-bound — a project-local one puts an agent's transcripts
	// where no fixed glob will look. The daemon recorded the path pi itself
	// reported, so it stays the authoritative answer for those.
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-locate-"));
	try {
		const db = openDb(join(root, "state.db"));
		enqueue(db, {
			event: cliEvent("elsewhere"), lane: "batch", agent: "a", task: "t",
			maxDurationS: 60, requireCleanTree: false, retryable: true,
		});
		const job = claimNextJob(db, 2);
		recordRunStart(db, job!.runId, {
			sessionFile: "/srv/custom-sessions/--work--/2026-08-04T00-00-00-000Z_019fabcd-1111-7000-8000-000000000000.jsonl",
			sessionId: "019fabcd-1111-7000-8000-000000000000",
		});

		const byPrefix = locateSessions(db, "019fabcd");
		assert.equal(byPrefix.length, 1);
		assert.match(byPrefix[0]!.sessionFile, /^\/srv\/custom-sessions\//,
			"the recorded absolute path, not a guess at where pi keeps sessions");

		assert.equal(locateSessions(db, "019fZZZZ").length, 0);
		// Case-sensitive, matching pi's startsWith and the CLI's own glob. SQLite's
		// LIKE folds ASCII case by default, so a rewrite that reached for it would
		// silently make this lookup the odd one out.
		assert.equal(locateSessions(db, "019FABCD").length, 0, "uppercase is a different prefix");
		// A run that never opened a session has nothing to locate.
		assert.equal(locateSessions(db, "").length, 1, "an empty ref matches everything with a file, nothing without");
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the claim opens the run row; the handshake capture survives a SIGKILLed daemon", () => {
	// The hole this pins: the run row used to be inserted only at settle time, so
	// a daemon killed mid-run left NO record of the session pi had opened — the
	// one transcript the operator most wants to resume. Now the claim opens the
	// row and recordRunStart persists the handshake facts as they arrive; a
	// restart's markInterrupted closes that same row with the session intact.
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-capture-"));
	try {
		const db = openDb(join(root, "state.db"));
		enqueue(db, {
			event: cliEvent("early"), lane: "batch", agent: "a", task: "t",
			maxDurationS: 60, requireCleanTree: false, retryable: true,
			notify: { sink: "tg", when: "always" },
		});
		const job = claimNextJob(db, 2);
		assert.ok(job);

		const open = db.prepare("SELECT outcome, session_file FROM runs WHERE id = ?").get(job.runId) as {
			outcome: string | null; session_file: string | null;
		};
		assert.equal(open.outcome, null, "open until settled: jobs.state='running' <=> one run row with outcome NULL");
		assert.equal(open.session_file, null);

		recordRunStart(db, job.runId, { pid: 4242 });
		recordRunStart(db, job.runId, {
			sessionFile: "/tmp/s.jsonl",
			sessionId: "019f9951-a6b5-7204-80f6-cfb098998b0b",
		});

		// The daemon dies here (nothing else writes); a restart marks interrupted.
		markInterrupted(db);

		const after = db.prepare(
			"SELECT outcome, pid, session_file, session_id FROM runs WHERE id = ?",
		).get(job.runId) as { outcome: string; pid: number; session_file: string; session_id: string };
		assert.equal(after.outcome, "interrupted");
		assert.equal(after.pid, 4242);
		assert.equal(after.session_file, "/tmp/s.jsonl", "the whole point: the transcript pointer survives the crash");
		assert.equal(after.session_id, "019f9951-a6b5-7204-80f6-cfb098998b0b");

		// Saving the id and then not telling anyone would be half a fix: the
		// interrupted message is exactly where the offer to continue matters.
		const body = (db.prepare("SELECT body FROM outbox ORDER BY id DESC LIMIT 1").get() as { body: string } | undefined)?.body;
		assert.match(
			body ?? "",
			/↩ pi-reactor resume 019f9951-a6b5-7204-80f6-cfb098998b0b/,
			"the interruption notice must carry the session the handshake captured",
		);
		assert.equal(
			(db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1,
			"exactly one row per attempt — markInterrupted closes the open row, never inserts a second",
		);
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a retry returns the job to pending with a backoff instead of a terminal state", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-retry-"));
	try {
		const db = openDb(join(root, "state.db"));
		const { jobId } = enqueue(db, {
			event: cliEvent("retry-me"), lane: "batch", agent: "report", task: "t",
			maxDurationS: 60, requireCleanTree: false, retryable: true,
		});
		const claimed = claimNextJob(db, 2);

		const retryAt = new Date(Date.now() + 60_000).toISOString();
		finishJob(db, {
			jobId: jobId!, runId: claimed!.runId, outcome: "failed", reason: "provider_error", retryAt,
		});

		const job = db.prepare("SELECT state, attempts, scheduled_at FROM jobs WHERE id = ?").get(jobId!) as {
			state: string; attempts: number; scheduled_at: string;
		};
		assert.equal(job.state, "pending");
		assert.equal(job.attempts, 1);
		assert.equal(job.scheduled_at, retryAt);

		assert.equal(claimNextJob(db, 2), null, "a backed-off job is not claimable before its time");
		assert.equal(queueCounts(db).pending, 1);

		// A run row is still written, so the attempt is visible in history.
		const runs = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE job_id = ?").get(jobId!) as { n: number };
		assert.equal(runs.n, 1);
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

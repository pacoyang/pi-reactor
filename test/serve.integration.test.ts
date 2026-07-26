/**
 * The daemon end to end, against a real process.
 *
 * Each test maps to an acceptance item from the plan: enqueue and record, dedup,
 * per-agent serialisation, the timeout chain, interrupted recovery after a hard
 * kill, and singleton refusal.
 *
 * Jobs run a stub "agent" rather than pi: the contract test already pins the
 * real protocol, and these need to be fast and deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { resolvePaths, type Paths } from "../src/core/paths.ts";
import { openDb } from "../src/core/db.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { serve, type RunningDaemon } from "../src/daemon/serve.ts";
import { acquireLock, LockError } from "../src/daemon/lock.ts";

const quiet = createLogger({ level: "error", write: () => {} });

interface Fixture {
	paths: Paths;
	root: string;
	cleanup(): void;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-serve-"));
	const workspace = join(root, "workspace");
	mkdirSync(workspace, { recursive: true });
	const dir = join(root, "reactor");
	mkdirSync(dir, { recursive: true });

	writeFileSync(
		join(dir, "agents.json"),
		JSON.stringify({ agents: { report: { cwd: workspace, model: "stub/model" } } }),
	);
	writeFileSync(join(dir, "sinks.json"), JSON.stringify({ sinks: { tg: { kind: "telegram", chatId: 1 } } }));

	return {
		paths: resolvePaths({ PI_REACTOR_DIR: dir }),
		root,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Minimal JSON-RPC client, mirroring what the CLI does. */
function call(paths: Paths, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = connect(paths.sock);
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		socket.on("error", reject);
		socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`));
		socket.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			const i = buffer.indexOf("\n");
			if (i === -1) return;
			socket.end();
			const response = JSON.parse(buffer.slice(0, i)) as { result?: unknown; error?: { message: string } };
			if (response.error) reject(new Error(response.error.message));
			else resolve(response.result);
		});
	});
}

async function withDaemon(f: Fixture, fn: (d: RunningDaemon) => Promise<void>): Promise<void> {
	const daemon = await serve({
		paths: f.paths,
		logger: quiet,
		installSignalHandlers: false,
		workerTickMs: 50,
		shutdownGraceMs: 2000,
	});
	try {
		await fn(daemon);
	} finally {
		await daemon.stop();
	}
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("startup: socket answers, status reports a live daemon", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			const s = (await call(f.paths, "status")) as { pid: number; paused: boolean; agents: string[] };
			assert.equal(s.pid, process.pid);
			assert.equal(s.paused, false);
			assert.deepEqual(s.agents, ["report"]);
		});
	} finally {
		f.cleanup();
	}
});

test("emit writes event and job in one transaction", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			const r = (await call(f.paths, "emit", {
				lane: "batch",
				route: { agent: "report", task: "summarise" },
			})) as { seq: number; jobId: number; duplicate: boolean };
			assert.equal(r.duplicate, false);
			assert.ok(r.jobId > 0);

			const db = openDb(f.paths.db);
			const job = db.prepare("SELECT agent, task, event_seq FROM jobs WHERE id = ?").get(r.jobId) as {
				agent: string; task: string; event_seq: number;
			};
			assert.equal(job.agent, "report");
			assert.equal(job.task, "summarise");
			assert.equal(job.event_seq, r.seq);
			db.close();
		});
	} finally {
		f.cleanup();
	}
});

test("a repeated (source,id) is an idempotent success, not a second job", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			const ce = {
				specversion: "1.0",
				id: "nightly:2026-07-27T09:00:00Z",
				source: "cron:nightly",
				type: "dev.pi-reactor.cron.fired",
			};
			const first = (await call(f.paths, "emit", { ce, lane: "batch", route: { agent: "report", task: "t" } })) as {
				seq: number; jobId: number; duplicate: boolean;
			};
			const second = (await call(f.paths, "emit", { ce, lane: "batch", route: { agent: "report", task: "t" } })) as {
				seq: number; jobId: number | null; duplicate: boolean;
			};

			assert.equal(first.duplicate, false);
			assert.equal(second.duplicate, true, "cron catch-up and webhook redelivery legitimately replay a key");
			assert.equal(second.seq, first.seq, "the existing seq comes back so the caller can still correlate");
			assert.equal(second.jobId, null);

			const db = openDb(f.paths.db);
			const count = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
			assert.equal(count.n, 1, "exactly one job for one logical event");
			db.close();
		});
	} finally {
		f.cleanup();
	}
});

test("emit is refused for an unknown agent, an unknown sink, and a non-batch lane", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await assert.rejects(
				() => call(f.paths, "emit", { route: { agent: "ghost", task: "t" } }),
				/unknown agent/,
			);
			await assert.rejects(
				() => call(f.paths, "emit", { route: { agent: "report", task: "t" }, notify: { sink: "ghost" } }),
				/unknown sink/,
			);
			await assert.rejects(
				() => call(f.paths, "emit", { lane: "interactive", route: { agent: "report", task: "t" } }),
				/not implemented/,
				"refusing loudly beats silently running interactive work through the batch queue",
			);
			await assert.rejects(() => call(f.paths, "emit", { route: { agent: "report" } }), /task or a skill/);
		});
	} finally {
		f.cleanup();
	}
});

test("unknown method returns JSON-RPC -32601 without killing the connection", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await assert.rejects(() => call(f.paths, "no.such.method"), /unknown method/);
			const s = (await call(f.paths, "status")) as { pid: number };
			assert.equal(s.pid, process.pid, "the daemon is still serving after an unknown method");
		});
	} finally {
		f.cleanup();
	}
});

test("pause is durable: it survives a daemon restart", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await call(f.paths, "pause");
			const s = (await call(f.paths, "status")) as { paused: boolean };
			assert.equal(s.paused, true);
		});

		await withDaemon(f, async () => {
			const s = (await call(f.paths, "status")) as { paused: boolean };
			assert.equal(s.paused, true, "a paused daemon comes back paused, jobs wait rather than surprise-run");
			await call(f.paths, "resume");
		});
	} finally {
		f.cleanup();
	}
});

test("reload rejects a bad config and keeps the previous one live", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			writeFileSync(f.paths.agentsFile, "{ not json");
			await assert.rejects(() => call(f.paths, "reload"), /keeping the previous one/);

			const s = (await call(f.paths, "status")) as { agents: string[] };
			assert.deepEqual(s.agents, ["report"], "a bad edit must not disable the agents already running");

			const r = (await call(f.paths, "emit", { route: { agent: "report", task: "still works" } })) as {
				jobId: number;
			};
			assert.ok(r.jobId > 0);
		});
	} finally {
		f.cleanup();
	}
});

test("a job left running by a dead daemon is marked interrupted at startup", async () => {
	const f = fixture();
	try {
		// Simulate the crash: create the schema, insert a running job, leave it.
		await withDaemon(f, async () => {
			await call(f.paths, "pause"); // keep the worker from claiming it
			await call(f.paths, "emit", {
				route: { agent: "report", task: "t" },
				notify: { sink: "tg", when: "always" },
			});
		});

		const db = openDb(f.paths.db);
		db.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = 1").run(new Date().toISOString());
		db.close();

		await withDaemon(f, async () => {
			const after = openDb(f.paths.db);
			const job = after.prepare("SELECT state FROM jobs WHERE id = 1").get() as { state: string };
			assert.equal(job.state, "interrupted",
				"the harness died, so whether the work landed is unknown: an epistemic state, not a verdict");

			// The state flip alone used to be all that happened, which quietly dropped
			// exactly the message the outbox exists to guarantee: an agent killed mid-run
			// notified, but a daemon that died under it did not. It also left
			// `interrupted` unreachable in runs, so `runs --dead` could never show one.
			const run = after
				.prepare("SELECT outcome, error_summary FROM runs WHERE job_id = 1")
				.get() as { outcome: string; error_summary: string } | undefined;
			assert.equal(run?.outcome, "interrupted", "the run must be in history, not only the job state");
			assert.match(run?.error_summary ?? "", /outcome is unknown/);

			const outbox = after
				.prepare("SELECT sink, body FROM outbox WHERE state = 'pending'")
				.all() as Array<{ sink: string; body: string }>;
			assert.equal(outbox.length, 1, "the operator hears about a run the daemon died under");
			assert.equal(outbox[0]?.sink, "tg");
			assert.match(outbox[0]?.body ?? "", /interrupted/);

			after.close();
			await call(f.paths, "resume");
		});
	} finally {
		f.cleanup();
	}
});

test("rerun queues the same work as a NEW job, keeping the original as history", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await call(f.paths, "pause");
			await call(f.paths, "emit", {
				route: { agent: "report", task: "the original task", maxDuration: "7m" },
				notify: { sink: "tg", when: "failure" },
			});

			const again = (await call(f.paths, "rerun", { job: 1 })) as { jobId: number; duplicate: boolean };
			assert.equal(again.duplicate, false, "a fresh event id: the old one still means the occurrence it recorded");
			assert.equal(again.jobId, 2);

			const db = openDb(f.paths.db);
			const rows = db
				.prepare("SELECT id, task, max_duration_s, notify_sink, notify_when FROM jobs ORDER BY id")
				.all() as Array<{ id: number; task: string; max_duration_s: number; notify_sink: string; notify_when: string }>;
			assert.equal(rows.length, 2, "the original stays; nothing is revived in place");
			assert.equal(rows[1]?.task, "the original task");
			assert.equal(rows[1]?.max_duration_s, 420, "routing is carried over, not re-defaulted");
			assert.equal(rows[1]?.notify_sink, "tg");
			assert.equal(rows[1]?.notify_when, "failure");
			db.close();

			await assert.rejects(() => call(f.paths, "rerun", { job: 999 }), /no job 999/);
			await assert.rejects(() => call(f.paths, "rerun", {}), /needs a job or a run id/);
			await call(f.paths, "resume");
		});
	} finally {
		f.cleanup();
	}
});

test("emit reports a bad duration as invalid params, not an internal error", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			// -32603 sends the operator reading daemon logs for a fault that is theirs
			// to fix. And `[1]` used to coerce to "1" and silently mean one second.
			for (const maxDuration of [[1], "nope", {}]) {
				const err = await call(f.paths, "emit", {
					route: { agent: "report", task: "t", maxDuration },
				}).then(() => null, (e: Error) => e);
				assert.match(err?.message ?? "", /maxDuration/);
			}
		});
	} finally {
		f.cleanup();
	}
});

test("a second daemon on the same directory refuses to start", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await assert.rejects(
				() => serve({ paths: f.paths, logger: quiet, installSignalHandlers: false }),
				(err: unknown) => err instanceof LockError && /already|another/i.test(err.message),
				"two daemons would mean two writers and two schedulers",
			);
		});
	} finally {
		f.cleanup();
	}
});

test("a stale lock from a dead process is taken over", () => {
	const f = fixture();
	try {
		// PID 1 exists but is not us; a definitely-dead pid is what we need.
		const deadPid = 2 ** 22 - 1;
		writeFileSync(f.paths.pidFile, JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }));
		const lock = acquireLock(f.paths.pidFile);
		lock.release();
		assert.ok(true, "a stale lock file must not block startup forever");
	} finally {
		f.cleanup();
	}
});

test("notify queues an outbox row and returns immediately", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			const { outboxId } = (await call(f.paths, "notify", { sink: "tg", body: "checkpoint" })) as {
				outboxId: number;
			};
			assert.ok(outboxId > 0);

			const db = openDb(f.paths.db);
			const row = db.prepare("SELECT sink, body, state FROM outbox WHERE id = ?").get(outboxId) as {
				sink: string; body: string; state: string;
			};
			// node:sqlite returns null-prototype rows, so compare fields rather than shapes.
			assert.equal(row.sink, "tg");
			assert.equal(row.body, "checkpoint");
			assert.equal(row.state, "pending");
			db.close();
		});
	} finally {
		f.cleanup();
	}
});

test("a job whose provider has no credential is refused before spawn", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await call(f.paths, "emit", { route: { agent: "report", task: "t" } });
			// The stub provider has no credential anywhere, so gate 1 refuses it.
			await sleep(600);

			const db = openDb(f.paths.db);
			const job = db.prepare("SELECT state, reason FROM jobs WHERE id = 1").get() as {
				state: string; reason: string | null;
			};
			assert.equal(job.state, "failed");
			assert.equal(job.reason, "config_error",
				"a missing credential is caught by the gate, not by waiting for prompt to answer");

			const run = db.prepare("SELECT outcome, reason, error_summary FROM runs WHERE job_id = 1").get() as {
				outcome: string; reason: string; error_summary: string;
			};
			assert.equal(run.outcome, "failed");
			assert.match(run.error_summary, /no credential for provider/);
			db.close();
		});
	} finally {
		f.cleanup();
	}
});

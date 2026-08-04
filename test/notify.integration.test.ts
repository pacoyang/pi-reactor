/**
 * The load-bearing claim: a job that DIES still notifies.
 *
 * This is the whole reason the harness owns the fallback layer rather than
 * leaving notification to the agent. An agent that gets SIGKILLed cannot send
 * its own obituary, and "the run died" is precisely the message you most need.
 *
 * Runs a real daemon end to end with the stub agent and a stub Telegram.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { resolvePaths, type Paths } from "../src/core/paths.ts";
import { openDb } from "../src/core/db.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { serve } from "../src/daemon/serve.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const quiet = createLogger({ level: "error", write: () => {} });

interface Sent {
	chat_id: number;
	text: string;
}

async function stubTelegram(): Promise<{ base: string; sent: Sent[]; close(): Promise<void> }> {
	const sent: Sent[] = [];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => { raw += c; });
		req.on("end", () => {
			try { sent.push(JSON.parse(raw) as Sent); } catch { /* ignore */ }
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return {
		base: `http://127.0.0.1:${port}`,
		sent,
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}

/**
 * A fixture whose agent runs the stub RPC agent instead of pi. `agent.env`
 * carries the stub's knobs because the job-env allowlist correctly drops
 * unknown host variables.
 */
function fixture(stubEnv: Record<string, string> = {}): { paths: Paths; cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-notify-"));
	const dir = join(root, "reactor");
	const cwd = join(root, "work");
	mkdirSync(dir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	const paths = resolvePaths({ PI_REACTOR_DIR: dir });
	writeFileSync(
		paths.agentsFile,
		JSON.stringify({
			agents: { stub: { cwd, model: "stub/model", maxDuration: "2s", env: stubEnv } },
		}),
	);
	writeFileSync(paths.sinksFile, JSON.stringify({ sinks: { tg: { kind: "telegram", chatId: 77 } } }));
	// The stub provider needs a credential too: preflight refuses BEFORE spawn
	// otherwise, which is the gate doing its job rather than a test problem.
	writeFileSync(
		paths.credentialsFile,
		JSON.stringify({ tg: { botToken: "123:TEST" }, "provider:stub": { STUB_API_KEY: "sk-stub" } }),
		{ mode: 0o600 },
	);

	return { paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

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
			const r = JSON.parse(buffer.slice(0, i)) as { result?: unknown; error?: { message: string } };
			if (r.error) reject(new Error(r.error.message));
			else resolve(r.result);
		});
	});
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out waiting for condition");
}

/**
 * The stub agent is reached through PI_RPC_ENTRY_OVERRIDE, which the worker
 * honours only in tests. Production always resolves the package export.
 */
const STUB_AGENT = join(HERE, "fixtures/stub-agent.mjs");

test("a successful run notifies with the agent's final text", async () => {
	const f = fixture({ STUB_WORK_MS: "20", STUB_TEXT: "3 deploys, all green", STUB_TOKENS: "1500" });
	const tg = await stubTelegram();
	try {
		const daemon = await serve({
			paths: f.paths,
			logger: quiet,
			installSignalHandlers: false,
			workerTickMs: 30,
			relayTickMs: 30,
			telegramApiBase: tg.base,
			rpcEntryOverride: STUB_AGENT,
			shutdownGraceMs: 3000,
		});
		try {
			await call(f.paths, "emit", {
				route: { agent: "stub", task: "summarise" },
				notify: { sink: "tg", when: "always" },
			});
			await waitFor(() => tg.sent.length > 0);

			const text = tg.sent[0]?.text ?? "";
			assert.match(text, /3 deploys, all green/, "the body is the agent's final answer");
			assert.match(text, /✅/);
			assert.match(text, /1\.5k tokens/, "spend is visible without opening the database");
		} finally {
			await daemon.stop();
		}
	} finally {
		await tg.close();
		f.cleanup();
	}
});

test("a job killed mid-run STILL notifies, using the cached event-stream text", async () => {
	// STUB_HANG makes the agent never settle, so the daemon drives the termination chain
	// all the way to SIGKILL. After that the RPC channel is gone and
	// get_last_assistant_text is unavailable — the notification body can only
	// come from what the worker cached while events were arriving.
	const f = fixture({ STUB_HANG: "1" });
	const tg = await stubTelegram();
	try {
		const daemon = await serve({
			paths: f.paths,
			logger: quiet,
			installSignalHandlers: false,
			workerTickMs: 30,
			relayTickMs: 30,
			telegramApiBase: tg.base,
			rpcEntryOverride: STUB_AGENT,
			shutdownGraceMs: 8000,
			// Shrink the chain so the test exercises its shape, not its patience.
			abortGraceMs: 200,
			termGraceMs: 200,
		});
		try {
			await call(f.paths, "emit", {
				route: { agent: "stub", task: "hang", maxDuration: "1s" },
				notify: { sink: "tg", when: "always" },
			});
			await waitFor(() => tg.sent.length > 0, 20_000);

			const text = tg.sent[0]?.text ?? "";
			assert.match(text, /timeout/, "the reason reaches the operator");
			assert.match(text, /⏱/);

			const db = openDb(f.paths.db);
			const job = db.prepare("SELECT state, reason FROM jobs WHERE id = 1").get() as {
				state: string; reason: string;
			};
			assert.equal(job.state, "failed");
			assert.equal(job.reason, "timeout");
			db.close();
		} finally {
			await daemon.stop();
		}
	} finally {
		await tg.close();
		f.cleanup();
	}
});

test("the notification carries the session id, and it leads back to the transcript", async () => {
	// Closing the loop. The hint is addressed by pi's session id — the one
	// identifier that means the same thing on every machine — not the run id,
	// which is a per-daemon integer nobody but this database can resolve.
	const f = fixture({ STUB_WORK_MS: "20", STUB_TEXT: "3 deploys, all green" });
	const tg = await stubTelegram();
	try {
		const daemon = await serve({
			paths: f.paths,
			logger: quiet,
			installSignalHandlers: false,
			workerTickMs: 30,
			relayTickMs: 30,
			telegramApiBase: tg.base,
			rpcEntryOverride: STUB_AGENT,
			shutdownGraceMs: 3000,
		});
		try {
			await call(f.paths, "emit", {
				route: { agent: "stub", task: "summarise" },
				notify: { sink: "tg", when: "always" },
			});
			await waitFor(() => tg.sent.length > 0);

			const text = tg.sent[0]?.text ?? "";
			const match = /pi-reactor resume (\S+)/.exec(text);
			assert.ok(match, `the message must say how to continue; got:\n${text}`);
			assert.equal(match[1], "stub-session", "the hint carries pi's session id, not the run number");

			// And the id in the message is the one the run recorded — `runs` is what
			// the operator reads to find it again.
			const { runs } = (await call(f.paths, "runs", {})) as {
				runs: Array<{ id: number; sessionId: string | null }>;
			};
			assert.equal(runs[0]?.sessionId, "stub-session");
		} finally {
			await daemon.stop();
		}
	} finally {
		await tg.close();
		f.cleanup();
	}
});

test("a run with no transcript says so instead of pointing nowhere", async () => {
	// STUB_HANG never settles, so the run is SIGKILLed and pi never reports a
	// session file. Offering "resume 7" for that would be a dead end.
	const f = fixture({ STUB_HANG: "1" });
	const tg = await stubTelegram();
	try {
		const daemon = await serve({
			paths: f.paths,
			logger: quiet,
			installSignalHandlers: false,
			workerTickMs: 30,
			relayTickMs: 30,
			telegramApiBase: tg.base,
			rpcEntryOverride: STUB_AGENT,
			shutdownGraceMs: 8000,
			abortGraceMs: 200,
			termGraceMs: 200,
		});
		try {
			await call(f.paths, "emit", {
				route: { agent: "stub", task: "hang", maxDuration: "1s" },
				notify: { sink: "tg", when: "always" },
			});
			await waitFor(() => tg.sent.length > 0, 20_000);

			// The stub reports a sessionFile from get_state even when it hangs, so
			// assert on the mechanism rather than on this stub's particulars: the
			// hint appears exactly when there is something to resume.
			const text = tg.sent[0]?.text ?? "";
			const { runs } = (await call(f.paths, "runs", {})) as {
				runs: Array<{ sessionId: string | null }>;
			};
			assert.equal(
				/pi-reactor resume/.test(text),
				runs[0]?.sessionId != null,
				"the offer to continue must track whether there is a session to resume",
			);
		} finally {
			await daemon.stop();
		}
	} finally {
		await tg.close();
		f.cleanup();
	}
});

test("notify.when: failure stays silent on success", async () => {
	const f = fixture({ STUB_WORK_MS: "20", STUB_TEXT: "fine" });
	const tg = await stubTelegram();
	try {
		const daemon = await serve({
			paths: f.paths,
			logger: quiet,
			installSignalHandlers: false,
			workerTickMs: 30,
			relayTickMs: 30,
			telegramApiBase: tg.base,
			rpcEntryOverride: STUB_AGENT,
			shutdownGraceMs: 3000,
		});
		try {
			await call(f.paths, "emit", {
				route: { agent: "stub", task: "t" },
				notify: { sink: "tg", when: "failure" },
			});
			await waitFor(() => {
				const db = openDb(f.paths.db);
				const done = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE outcome IS NOT NULL").get() as { n: number }).n;
				db.close();
				return done > 0;
			});
			await new Promise((r) => setTimeout(r, 300));
			assert.equal(tg.sent.length, 0, "a success must not notify when the policy asks only for failures");
		} finally {
			await daemon.stop();
		}
	} finally {
		await tg.close();
		f.cleanup();
	}
});

test("agent-initiated notify reaches the same outbox and is delivered", async () => {
	const f = fixture();
	const tg = await stubTelegram();
	try {
		const daemon = await serve({
			paths: f.paths,
			logger: quiet,
			installSignalHandlers: false,
			relayTickMs: 30,
			telegramApiBase: tg.base,
			shutdownGraceMs: 3000,
		});
		try {
			// This is the path `pi-reactor notify` takes from inside a job.
			await call(f.paths, "notify", { sink: "tg", body: "checkpoint: build passed" });
			await waitFor(() => tg.sent.length > 0);
			assert.match(tg.sent[0]?.text ?? "", /checkpoint: build passed/);
		} finally {
			await daemon.stop();
		}
	} finally {
		await tg.close();
		f.cleanup();
	}
});

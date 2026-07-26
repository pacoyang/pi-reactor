/**
 * The outbox survives, retries with backoff, obeys 429 without
 * spending an attempt, and delivers a failure notification even when the agent
 * was killed.
 *
 * Deliveries hit a local stub HTTP server so the request shape is asserted
 * exactly; the real Bot API is never contacted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { openDb, type Db } from "../src/core/db.ts";
import { resolvePaths, type Paths } from "../src/core/paths.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { createRelay, MAX_ATTEMPTS } from "../src/daemon/relay.ts";
import { insertOutbox } from "../src/daemon/store.ts";
import { parseAgents, parseSinks, type Config } from "../src/core/config.ts";
import { splitForTelegram, renderTelegramHtml, TELEGRAM_MAX_TEXT } from "../src/daemon/sink-telegram.ts";
import { renderSlackMrkdwn, escapeSlack } from "../src/daemon/sink-slack.ts";

const quiet = createLogger({ level: "error", write: () => {} });

interface Captured {
	chat_id: number;
	text: string;
	parse_mode?: string;
}

interface Stub {
	base: string;
	requests: Captured[];
	/** Status to answer with; 200 by default. */
	respond(status: number, body?: unknown): void;
	close(): Promise<void>;
}

async function stubTelegram(): Promise<Stub> {
	const requests: Captured[] = [];
	let status = 200;
	let payload: unknown = { ok: true };

	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => { raw += c; });
		req.on("end", () => {
			try {
				requests.push(JSON.parse(raw) as Captured);
			} catch {
				// ignore
			}
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(payload));
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		base: `http://127.0.0.1:${port}`,
		requests,
		respond(s, body) {
			status = s;
			payload = body ?? { ok: s < 400 };
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

interface Env {
	db: Db;
	paths: Paths;
	config: Config;
	cleanup(): void;
}

function env(): Env {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-relay-"));
	const dir = join(root, "reactor");
	const cwd = join(root, "work");
	mkdirSync(dir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	const paths = resolvePaths({ PI_REACTOR_DIR: dir });
	// The credential lives in its own 0600 file, never in sinks.json.
	writeFileSync(paths.credentialsFile, JSON.stringify({ tg: { botToken: "123:TEST" } }), { mode: 0o600 });

	return {
		db: openDb(paths.db),
		paths,
		config: {
			agents: parseAgents({ agents: { report: { cwd, model: "stub/model" } } }, "a"),
			sinks: parseSinks({ sinks: { tg: { kind: "telegram", chatId: 4242 } } }, "s"),
			triggers: [],
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function outboxRow(db: Db, id: number): { state: string; attempts: number; scheduled_at: string | null } {
	return db.prepare("SELECT state, attempts, scheduled_at FROM outbox WHERE id = ?").get(id) as {
		state: string; attempts: number; scheduled_at: string | null;
	};
}

test("a queued notification is delivered and marked sent", async () => {
	const e = env();
	const stub = await stubTelegram();
	try {
		const id = insertOutbox(e.db, "tg", "**done** — 3 deploys, all green");
		const relay = createRelay({
			db: e.db, paths: e.paths, logger: quiet, getConfig: () => e.config, apiBase: stub.base,
		});
		const sent = await relay.flush();

		assert.equal(sent, 1);
		assert.equal(stub.requests.length, 1);
		assert.equal(stub.requests[0]?.chat_id, 4242);
		assert.equal(stub.requests[0]?.parse_mode, "HTML");
		assert.match(stub.requests[0]?.text ?? "", /<b>done<\/b>/, "Markdown is rendered to Telegram's HTML subset");
		assert.equal(outboxRow(e.db, id).state, "sent");
	} finally {
		await stub.close();
		e.cleanup();
	}
});

test("a 429 obeys retry_after and does NOT consume an attempt", async () => {
	const e = env();
	const stub = await stubTelegram();
	try {
		const id = insertOutbox(e.db, "tg", "hello");
		stub.respond(429, { ok: false, parameters: { retry_after: 42 } });

		const relay = createRelay({
			db: e.db, paths: e.paths, logger: quiet, getConfig: () => e.config, apiBase: stub.base,
		});
		await relay.flush();

		const row = outboxRow(e.db, id);
		assert.equal(row.state, "pending");
		assert.equal(row.attempts, 0, "throttling is not failure: a busy chat must not burn the retry budget");
		assert.ok(row.scheduled_at);
		const waitMs = new Date(row.scheduled_at as string).getTime() - Date.now();
		assert.ok(waitMs > 35_000 && waitMs < 45_000, `should wait their 42s, computed ${Math.round(waitMs / 1000)}s`);
	} finally {
		await stub.close();
		e.cleanup();
	}
});

test("a server error backs off and increments attempts", async () => {
	const e = env();
	const stub = await stubTelegram();
	try {
		const id = insertOutbox(e.db, "tg", "hello");
		stub.respond(500, { ok: false, description: "Internal Server Error" });

		const relay = createRelay({
			db: e.db, paths: e.paths, logger: quiet, getConfig: () => e.config, apiBase: stub.base,
		});
		await relay.flush();

		const row = outboxRow(e.db, id);
		assert.equal(row.state, "pending");
		assert.equal(row.attempts, 1);
		// One minute, equal-jittered: [30s, 60s]. The jitter is what stops a batch of
		// messages that failed together from retrying against the API in lockstep.
		const waitMs = new Date(row.scheduled_at as string).getTime() - Date.now();
		assert.ok(waitMs > 25_000 && waitMs <= 61_000, `first backoff step should land in [30s, 60s], got ${waitMs}ms`);
	} finally {
		await stub.close();
		e.cleanup();
	}
});

test("after the attempt budget the message is parked as dead, not retried forever", async () => {
	const e = env();
	const stub = await stubTelegram();
	try {
		const id = insertOutbox(e.db, "tg", "hello");
		e.db.prepare("UPDATE outbox SET attempts = ? WHERE id = ?").run(MAX_ATTEMPTS - 1, id);
		stub.respond(500);

		const relay = createRelay({
			db: e.db, paths: e.paths, logger: quiet, getConfig: () => e.config, apiBase: stub.base,
		});
		await relay.flush();

		assert.equal(outboxRow(e.db, id).state, "dead");
	} finally {
		await stub.close();
		e.cleanup();
	}
});

test("at-least-once: an unmarked row is re-sent after a restart", async () => {
	const e = env();
	const stub = await stubTelegram();
	try {
		const id = insertOutbox(e.db, "tg", "important");
		const relay = createRelay({
			db: e.db, paths: e.paths, logger: quiet, getConfig: () => e.config, apiBase: stub.base,
		});
		await relay.flush();
		assert.equal(outboxRow(e.db, id).state, "sent");

		// Simulate dying between a successful send and the UPDATE.
		e.db.prepare("UPDATE outbox SET state = 'pending', sent_at = NULL WHERE id = ?").run(id);
		await relay.flush();

		assert.equal(stub.requests.length, 2,
			"a duplicate notification is noise; a lost one is an outage you never hear about");
	} finally {
		await stub.close();
		e.cleanup();
	}
});

test("a message for a sink that no longer exists is parked, not retried", async () => {
	const e = env();
	try {
		const id = insertOutbox(e.db, "ghost", "orphan");
		const relay = createRelay({ db: e.db, paths: e.paths, logger: quiet, getConfig: () => e.config });
		await relay.flush();
		assert.equal(outboxRow(e.db, id).state, "dead", "no amount of retrying finds a deleted sink");
	} finally {
		e.cleanup();
	}
});

test("a missing credential fails the delivery rather than sending unauthenticated", async () => {
	const e = env();
	const stub = await stubTelegram();
	try {
		writeFileSync(e.paths.credentialsFile, "{}");
		const id = insertOutbox(e.db, "tg", "hello");
		const relay = createRelay({
			db: e.db, paths: e.paths, logger: quiet, getConfig: () => e.config, apiBase: stub.base,
		});
		await relay.flush();

		assert.equal(stub.requests.length, 0);
		assert.equal(outboxRow(e.db, id).state, "pending");
		assert.equal(outboxRow(e.db, id).attempts, 1);
	} finally {
		await stub.close();
		e.cleanup();
	}
});

test("an over-long body is split at paragraph boundaries into several messages", async () => {
	const e = env();
	const stub = await stubTelegram();
	try {
		const paragraph = `${"x".repeat(1000)}\n\n`;
		insertOutbox(e.db, "tg", paragraph.repeat(6)); // ~6000 chars
		const relay = createRelay({
			db: e.db, paths: e.paths, logger: quiet, getConfig: () => e.config, apiBase: stub.base,
		});
		await relay.flush();

		assert.ok(stub.requests.length >= 2, "4096 is a hard API limit, so a long report arrives as several messages");
		for (const r of stub.requests) {
			assert.ok((r.text?.length ?? 0) <= TELEGRAM_MAX_TEXT, "every chunk must fit the limit");
		}
	} finally {
		await stub.close();
		e.cleanup();
	}
});

test("one undeliverable message does not block the others behind it", async () => {
	// The relay used to `break` out of the drain on the first non-delivery, on the
	// reasoning that nothing else could be due. Other rows plainly can be — and at
	// shutdown, flush() would then deliver nothing past the first failure.
	const e = env();
	const stub = await stubTelegram();
	try {
		// "gone" is not in the config, so it can never be delivered; it sits first.
		const blocked = insertOutbox(e.db, "gone", "for a sink nobody configured");
		const behind = insertOutbox(e.db, "tg", "the one that matters");

		const relay = createRelay({
			db: e.db, paths: e.paths, logger: quiet, getConfig: () => e.config, apiBase: stub.base,
		});
		const sent = await relay.flush();

		assert.equal(sent, 1, "the deliverable message goes out in the SAME drain");
		assert.equal(outboxRow(e.db, blocked).state, "dead", "no amount of retrying finds a deleted sink");
		assert.equal(outboxRow(e.db, behind).state, "sent");
	} finally {
		await stub.close();
		e.cleanup();
	}
});

test("flush joins a drain already in progress instead of reporting zero", async () => {
	// Shutdown believed that zero: it closed the database out from under an
	// in-flight send, whose UPDATE then threw and left the row pending to be
	// re-delivered on the next start.
	const e = env();
	const stub = await stubTelegram();
	try {
		insertOutbox(e.db, "tg", "in flight");
		const relay = createRelay({
			db: e.db, paths: e.paths, logger: quiet, getConfig: () => e.config, apiBase: stub.base,
		});

		const first = relay.flush();
		const second = relay.flush(); // lands while the first is still awaiting fetch
		const [a, b] = await Promise.all([first, second]);

		// Both callers observe the same drain rather than the second reporting 0 —
		// that zero is what let shutdown believe it was safe to close the database.
		assert.equal(a, 1);
		assert.equal(b, a, "the second caller joins the drain rather than reporting nothing happened");
		assert.equal(stub.requests.length, 1, "and the message still goes out exactly once");
		assert.equal(
			(e.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get() as { n: number }).n,
			0,
			"and nothing is left in flight for a closing database to trip over",
		);
	} finally {
		await stub.close();
		e.cleanup();
	}
});

test("splitForTelegram prefers paragraph, then line, then a hard cut", () => {
	assert.deepEqual(splitForTelegram("short"), ["short"]);

	const paras = splitForTelegram(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
	assert.equal(paras.length, 2);
	assert.match(paras[0] as string, /^a+$/, "the split lands on the blank line, not mid-word");

	const oneLine = splitForTelegram("z".repeat(9000));
	assert.ok(oneLine.length >= 3, "a single oversized line still has to be cut");
	for (const c of oneLine) assert.ok(c.length <= TELEGRAM_MAX_TEXT);
});

test("splitForTelegram measures the RENDERED length, not the raw one", () => {
	// Escaping only grows text: `&` becomes `&amp;`, four characters more. Slicing
	// at 4096 raw characters and escaping afterwards produced chunks Telegram
	// rejected with 400 "message is too long" — and diffs and code blocks, where
	// `<` and `&` cluster, are exactly the payloads that hit it.
	const dense = "a & b < c > d ".repeat(600); // ~8400 raw, far more once escaped
	const chunks = splitForTelegram(dense);

	for (const chunk of chunks) {
		assert.ok(
			renderTelegramHtml(chunk).length <= TELEGRAM_MAX_TEXT,
			`a chunk rendered to ${renderTelegramHtml(chunk).length} characters, over the API limit`,
		);
	}
	assert.equal(chunks.join("").replace(/\s/g, ""), dense.replace(/\s/g, ""), "no content may be dropped");
});

test("no chunk is ever empty", () => {
	// Telegram rejects an empty `text` with a 400 no fallback here can rescue, so
	// an empty chunk burned all eight attempts and dead-lettered over blank space.
	// A whitespace run longer than the window is enough to produce one.
	const chunks = splitForTelegram(`${" ".repeat(5000)}\n\nthe actual report`);
	for (const chunk of chunks) assert.notEqual(chunk.trim(), "", "an empty chunk cannot be delivered");
	assert.ok(chunks.some((c) => c.includes("the actual report")), "and the content still survives");

	// A body that is nothing BUT whitespace has no non-empty chunk to give; the
	// original goes out so the failure is the API's to report, not a silent drop.
	assert.deepEqual(splitForTelegram(" ".repeat(9000)).length, 1);
});

test("renderTelegramHtml escapes first and never emits MarkdownV2", () => {
	// The reason MarkdownV2 is rejected: this input would need 18 escape rules.
	const html = renderTelegramHtml("a < b & c > d");
	assert.equal(html, "a &lt; b &amp; c &gt; d");

	assert.match(renderTelegramHtml("**bold**"), /<b>bold<\/b>/);
	assert.match(renderTelegramHtml("call `fn()` now"), /<code>fn\(\)<\/code>/);
	assert.match(renderTelegramHtml("[docs](https://example.com)"), /<a href="https:\/\/example\.com">docs<\/a>/);
	assert.match(renderTelegramHtml("## Heading"), /<b>Heading<\/b>/);

	// Code contents must never be re-interpreted as markup.
	const fenced = renderTelegramHtml("```\nif (a < b) **x**\n```");
	assert.match(fenced, /<pre>if \(a &lt; b\) \*\*x\*\*<\/pre>/,
		"markup inside code is escaped, not rendered");
});

// ---------------------------------------------------------------- slack

test("the slack sink translates Markdown into mrkdwn, which is not the same thing", () => {
	// Slack bold is ONE star, links are <url|label>, and exactly three characters
	// are escaped. Sending our Markdown raw would deliver literal asterisks.
	assert.equal(renderSlackMrkdwn("**done** and _fine_"), "*done* and _fine_");
	assert.equal(renderSlackMrkdwn("*emphasis*"), "_emphasis_", "one star is italic in Markdown, bold in mrkdwn");
	assert.equal(renderSlackMrkdwn("[docs](https://example.com)"), "<https://example.com|docs>");
	assert.equal(renderSlackMrkdwn("## Heading"), "*Heading*");
	assert.equal(renderSlackMrkdwn("a < b & c > d"), "a &lt; b &amp; c &gt; d");
	assert.match(renderSlackMrkdwn("call `fn()` now"), /`fn\(\)`/);

	// Markup inside code is escaped, never rendered.
	assert.match(renderSlackMrkdwn("```\nif (a < b) **x**\n```"), /if \(a &lt; b\) \*\*x\*\*/);
});

test("escapeSlack does the ampersand first, or it double-escapes its own output", () => {
	assert.equal(escapeSlack("&<>"), "&amp;&lt;&gt;");
	assert.equal(escapeSlack("already &amp; escaped"), "already &amp;amp; escaped",
		"escaping is not idempotent by design; it is applied exactly once");
});

test("a slack delivery goes out, and a 429 backs off without spending an attempt", async () => {
	const e = env();
	const stub = await stubTelegram(); // a plain HTTP stub; the URL is all Slack needs
	try {
		writeFileSync(e.paths.credentialsFile, JSON.stringify({ ops: { webhookUrl: `${stub.base}/services/T/B/x` } }), {
			mode: 0o600,
		});
		const config: Config = { ...e.config, sinks: parseSinks({ sinks: { ops: { kind: "slack-webhook" } } }, "s") };

		const id = insertOutbox(e.db, "ops", "**deploy** finished");
		const relay = createRelay({ db: e.db, paths: e.paths, logger: quiet, getConfig: () => config });
		assert.equal(await relay.flush(), 1);
		assert.equal(outboxRow(e.db, id).state, "sent");
		assert.match(stub.requests[0]?.text ?? "", /\*deploy\* finished/, "translated, not passed through raw");

		// Slack allows one message per second per webhook and says so with a header.
		stub.respond(429, {});
		const throttled = insertOutbox(e.db, "ops", "second");
		await relay.flush();
		const row = outboxRow(e.db, throttled);
		assert.equal(row.attempts, 0, "throttling is not failure and must not consume the attempt budget");
		assert.ok(row.scheduled_at, "but it does wait");
	} finally {
		await stub.close();
		e.cleanup();
	}
});

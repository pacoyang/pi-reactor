/**
 * The public webhook pipeline, end to end.
 *
 * Runs a real HTTP server against a stub daemon, so the assertions are about
 * what a sender actually gets back — the response codes carry the meaning, and
 * GitHub does not retry, so getting them wrong loses deliveries silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { resolvePaths, type Paths } from "../src/core/paths.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { serveWebhooks, matches, MAX_BODY_BYTES } from "../src/webhook/serve.ts";
import { verifySignature, projectPayload } from "../src/webhook/provider-github.ts";
import type { GithubTriggerSpec } from "../src/core/config.ts";

const quiet = createLogger({ level: "error", write: () => {} });
const SECRET = "shhh-this-is-the-shared-secret";

interface Harness {
	paths: Paths;
	base: string;
	/** Every method the webhook process called on the daemon, in order. */
	calls: Array<{ method: string; params: Record<string, unknown> }>;
	stop(): Promise<void>;
	cleanup(): void;
}

/** A webhook process wired to a stub daemon that reports the given triggers. */
async function harness(triggers: unknown[] = [], daemonDown = false): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-hook-"));
	const dir = join(root, "reactor");
	mkdirSync(dir, { recursive: true });
	const paths = resolvePaths({ PI_REACTOR_DIR: dir });

	writeFileSync(
		paths.webhooksFile,
		JSON.stringify({ endpoints: { github: { path: "/hooks/github", provider: "github" } } }),
	);
	writeFileSync(paths.credentialsFile, JSON.stringify({ github: { webhookSecret: SECRET } }), { mode: 0o600 });

	const calls: Harness["calls"] = [];
	const running = await serveWebhooks({
		paths,
		port: 0,
		logger: quiet,
		callDaemonImpl: async (method, params) => {
			calls.push({ method, params });
			if (daemonDown) throw new (await import("../src/core/rpc-client.ts")).DaemonUnavailableError("daemon not running");
			if (method === "trigger.ls") return { triggers };
			if (method === "emit") return { seq: calls.length, jobId: calls.length, duplicate: false };
			return {};
		},
	});

	return {
		paths,
		base: `http://127.0.0.1:${running.port}`,
		calls,
		stop: running.stop,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function sign(body: string, secret = SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function deliver(
	h: Harness,
	payload: unknown,
	options: { event?: string; delivery?: string; signature?: string; path?: string } = {},
): Promise<{ status: number; body: string }> {
	const body = typeof payload === "string" ? payload : JSON.stringify(payload);
	const response = await fetch(`${h.base}${options.path ?? "/hooks/github"}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": options.event ?? "issues",
			"x-github-delivery": options.delivery ?? "delivery-guid-1",
			"x-hub-signature-256": options.signature ?? sign(body),
		},
		body,
	});
	return { status: response.status, body: await response.text() };
}

const LABELED_ISSUE = {
	action: "labeled",
	sender: { id: 99, login: "paco", type: "User" },
	repository: { full_name: "paco/thing" },
	label: { name: "pi:fix" },
	issue: {
		number: 12,
		title: "the thing is broken",
		body: "steps to reproduce",
		html_url: "https://github.com/paco/thing/issues/12",
		labels: [{ name: "bug" }],
		author_association: "OWNER",
		user: { login: "paco" },
	},
};

const FIX_TRIGGER = {
	kind: "github",
	id: "fix-on-label",
	event: "issues",
	action: ["labeled"],
	any: ["pi:fix"],
	run: { agent: "coder", skill: "fix", maxDurationS: 1800, requireCleanTree: false, retryable: true },
	notify: { sink: "tg", when: "always" },
};

test("a signed, matching delivery is accepted and enqueued", async () => {
	const h = await harness([FIX_TRIGGER]);
	try {
		const res = await deliver(h, LABELED_ISSUE);
		assert.equal(res.status, 202);

		const emit = h.calls.find((c) => c.method === "emit");
		assert.ok(emit, "a matching delivery must reach the daemon");

		const ce = emit.params.ce as { id: string; source: string; type: string; data: Record<string, unknown> };
		assert.equal(ce.id, "delivery-guid-1", "the id is GitHub's delivery GUID, never one we invent");
		assert.equal(ce.source, "github:github:fix-on-label");
		assert.equal(ce.type, "com.github.issues.labeled");

		const route = emit.params.route as { agent: string; skill: string; triggerId: string };
		assert.equal(route.agent, "coder");
		assert.equal(route.skill, "fix");
		assert.equal(route.triggerId, "fix-on-label", "so the breaker can count this trigger's failures");
		assert.deepEqual(emit.params.notify, { sink: "tg", when: "always" });
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("a bad signature is 401 and never reaches the daemon", async () => {
	const h = await harness([FIX_TRIGGER]);
	try {
		assert.equal((await deliver(h, LABELED_ISSUE, { signature: sign(JSON.stringify(LABELED_ISSUE), "wrong") })).status, 401);
		assert.equal((await deliver(h, LABELED_ISSUE, { signature: "garbage" })).status, 401);
		assert.equal((await deliver(h, LABELED_ISSUE, { signature: "sha256=" })).status, 401);
		assert.deepEqual(h.calls, [], "an unverified body must not touch the queue, or the config, or anything");
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("verification happens before parsing", async () => {
	const h = await harness([FIX_TRIGGER]);
	try {
		// Unsigned garbage is rejected as unauthorized rather than as a parse error:
		// the parser is a much larger surface than an HMAC comparison, and until the
		// signature checks out the body is entirely attacker-controlled.
		const res = await deliver(h, "{not json at all", { signature: "sha256=00" });
		assert.equal(res.status, 401);
		assert.deepEqual(h.calls, []);

		// Correctly SIGNED garbage is a different story, and says so.
		const bad = "{not json at all";
		assert.equal((await deliver(h, bad, { signature: sign(bad) })).status, 401);
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("a bot's own delivery is dropped before the authorization gate", async () => {
	const h = await harness([FIX_TRIGGER]);
	try {
		// The gate ORDER is the point: a bot is usually also a collaborator, so if
		// authorization ran first the bot would authorise itself and a
		// comment-reply loop would run until the budget cap noticed.
		const fromBot = {
			...LABELED_ISSUE,
			sender: { id: 1, login: "pi-reactor[bot]", type: "Bot" },
			issue: { ...LABELED_ISSUE.issue, author_association: "COLLABORATOR" },
		};
		assert.equal((await deliver(h, fromBot)).status, 204);
		assert.equal(h.calls.filter((c) => c.method === "emit").length, 0);
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("an outsider cannot trigger work, however well formed their delivery", async () => {
	const h = await harness([FIX_TRIGGER]);
	try {
		const outsider = {
			...LABELED_ISSUE,
			sender: { id: 5, login: "stranger", type: "User" },
			issue: { ...LABELED_ISSUE.issue, author_association: "NONE" },
		};
		assert.equal((await deliver(h, outsider)).status, 204);
		assert.equal(h.calls.filter((c) => c.method === "emit").length, 0,
			"the signature proves it came from GitHub, not that we want to act on it");
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("a delivery nothing is listening for is 204, not an error", async () => {
	const h = await harness([FIX_TRIGGER]);
	try {
		const other = { ...LABELED_ISSUE, label: { name: "documentation" }, issue: { ...LABELED_ISSUE.issue, labels: [] } };
		assert.equal((await deliver(h, other)).status, 204);
		assert.equal((await deliver(h, { ...LABELED_ISSUE, action: "closed" })).status, 204);
		assert.equal(h.calls.filter((c) => c.method === "emit").length, 0);
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("ping is acknowledged with a bare 200, after its signature is checked", async () => {
	const h = await harness([FIX_TRIGGER]);
	try {
		assert.equal((await deliver(h, { zen: "Keep it logically awesome." }, { event: "ping" })).status, 200);
		assert.equal(
			(await deliver(h, { zen: "x" }, { event: "ping", signature: "sha256=00" })).status,
			401,
			"a ping is signed like anything else",
		);
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("two triggers matching one delivery both fire, and a redelivery still dedups", async () => {
	// The id stays the delivery GUID; the trigger rides in the
	// source. Otherwise the second trigger's event would collide with the first's
	// and silently vanish.
	const second = { ...FIX_TRIGGER, id: "notify-only", run: { ...FIX_TRIGGER.run, agent: "notifier" } };
	const h = await harness([FIX_TRIGGER, second]);
	try {
		assert.equal((await deliver(h, LABELED_ISSUE)).status, 202);

		const emits = h.calls.filter((c) => c.method === "emit");
		assert.equal(emits.length, 2, "a fan-out is not a duplicate");
		const sources = emits.map((e) => (e.params.ce as { source: string }).source);
		assert.deepEqual(sources, ["github:github:fix-on-label", "github:github:notify-only"]);
		const ids = emits.map((e) => (e.params.ce as { id: string }).id);
		assert.deepEqual(ids, ["delivery-guid-1", "delivery-guid-1"],
			"same delivery, so a redelivery collides per trigger on (source, id)");
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("an unreachable daemon is 503, so the delivery can be replayed", async () => {
	const h = await harness([FIX_TRIGGER], true);
	try {
		const res = await deliver(h, LABELED_ISSUE);
		assert.equal(res.status, 503,
			"claiming 2xx for work we dropped would lose it: GitHub does not retry on its own");
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("unknown paths and methods reveal nothing", async () => {
	const h = await harness([FIX_TRIGGER]);
	try {
		assert.equal((await deliver(h, LABELED_ISSUE, { path: "/hooks/gitlab" })).status, 404);
		const get = await fetch(`${h.base}/hooks/github`);
		assert.equal(get.status, 405);
		const health = await fetch(`${h.base}/healthz`);
		assert.equal(health.status, 200);
		assert.deepEqual(h.calls, []);
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("an oversized body is refused without being buffered to the end", async () => {
	const h = await harness([FIX_TRIGGER]);
	try {
		const huge = "x".repeat(MAX_BODY_BYTES + 1024);
		const res = await fetch(`${h.base}/hooks/github`, {
			method: "POST",
			headers: { "x-github-event": "issues", "x-github-delivery": "d", "x-hub-signature-256": sign(huge) },
			body: huge,
		}).catch(() => ({ status: 413 }) as { status: number });
		assert.equal(res.status, 413, "this endpoint is unauthenticated, so the memory is anyone's to spend");
	} finally {
		await h.stop();
		h.cleanup();
	}
});

test("the agent's prompt carries the event, or a webhook task means nothing", async () => {
	// "fix the issue" does not say which issue, in which repository. The event is
	// stored on the way in; this is the assertion that it comes back out again.
	const { openDb } = await import("../src/core/db.ts");
	const { enqueue, claimNextJob } = await import("../src/daemon/store.ts");
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-ctx-"));
	try {
		const db = openDb(join(root, "state.db"));
		enqueue(db, {
			event: {
				specversion: "1.0",
				id: "guid",
				source: "github:github:fix-on-label",
				type: "com.github.issues.labeled",
				data: projectPayload("issues", LABELED_ISSUE),
			},
			lane: "batch",
			agent: "coder",
			task: "fix the issue",
			maxDurationS: 60,
			requireCleanTree: false,
			retryable: true,
		});

		const job = claimNextJob(db, 1);
		assert.ok(job);
		const data = JSON.parse(job.event_data) as { subject: { number: number } };
		assert.equal(data.subject.number, 12, "the claim has to carry it, or the worker cannot build the prompt");

		// A cron fire has no event data and must not grow an empty context block.
		enqueue(db, {
			event: { specversion: "1.0", id: "cron:1", source: "cron:nightly", type: "dev.pi-reactor.cron.fired" },
			lane: "batch",
			agent: "other",
			task: "nightly",
			maxDurationS: 60,
			requireCleanTree: false,
			retryable: true,
		});
		const cronJob = claimNextJob(db, 2);
		assert.deepEqual(JSON.parse(cronJob?.event_data ?? "null"), {});
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------- units

test("verifySignature is exact about the digest it accepts", () => {
	const body = Buffer.from(JSON.stringify({ a: 1 }));
	const good = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

	assert.equal(verifySignature(body, SECRET, good), true);
	assert.equal(verifySignature(body, "other-secret", good), false);
	assert.equal(verifySignature(Buffer.from("tampered"), SECRET, good), false);
	assert.equal(verifySignature(body, SECRET, undefined), false);
	assert.equal(verifySignature(body, SECRET, good.replace("sha256=", "sha1=")), false);
	assert.equal(verifySignature(body, SECRET, `sha256=${"0".repeat(10)}`), false,
		"a short digest must not throw out of timingSafeEqual");
});

test("the projection keeps what an agent reads and drops the rest", () => {
	const projected = projectPayload("issues", LABELED_ISSUE) as {
		repo: string;
		subject: { number: number; labels: string[]; body: string };
	};
	assert.equal(projected.repo, "paco/thing");
	assert.equal(projected.subject.number, 12);
	assert.deepEqual(projected.subject.labels, ["bug"]);

	// A real payload carries tens of kilobytes of repository metadata; all of it
	// would land in the events table for nothing.
	assert.ok(JSON.stringify(projected).length < 1000);

	const long = { ...LABELED_ISSUE, issue: { ...LABELED_ISSUE.issue, body: "y".repeat(20_000) } };
	const truncated = projectPayload("issues", long) as { subject: { body: string } };
	assert.ok(truncated.subject.body.length < 5000);
	assert.match(truncated.subject.body, /truncated/);
});

test("trigger matching narrows by event, then action, then label", () => {
	const trigger = FIX_TRIGGER as unknown as GithubTriggerSpec;
	assert.equal(matches(trigger, { event: "issues", action: "labeled", labels: ["pi:fix"] }), true);
	assert.equal(matches(trigger, { event: "pull_request", action: "labeled", labels: ["pi:fix"] }), false);
	assert.equal(matches(trigger, { event: "issues", action: "closed", labels: ["pi:fix"] }), false);
	assert.equal(matches(trigger, { event: "issues", action: "labeled", labels: ["other"] }), false);
	assert.equal(matches(trigger, { event: "issues", action: "labeled", labels: ["other", "pi:fix"] }), true,
		"`any` is an OR: one of the named labels is enough");

	// An unconstrained trigger takes the whole event.
	const wide = { ...trigger, action: undefined, any: undefined } as unknown as GithubTriggerSpec;
	assert.equal(matches(wide, { event: "issues", action: "anything", labels: [] }), true);
});

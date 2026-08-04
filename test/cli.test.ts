/**
 * The CLI against a real daemon.
 *
 * Specifically the flags that carry more than one value. A last-one-wins flag map
 * is invisible until a field needs a list, and `extensions` is the field where
 * that stops being cosmetic: batch runs spawn pi with `-ne`, so a provider an
 * extension registers is unreachable unless that extension is named on the agent.
 * Before this existed the field was in the schema, honoured by the runner, and
 * unreachable from the CLI — an agent you could configure but never run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolvePaths, type Paths } from "../src/core/paths.ts";
import { openDb } from "../src/core/db.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { serve } from "../src/daemon/serve.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const quiet = createLogger({ level: "error", write: () => {} });

interface Fixture {
	paths: Paths;
	workspace: string;
	/** An empty pi agent dir of our own, so `resume`'s glob is hermetic. */
	agentDir: string;
	cli(...argv: string[]): Promise<string>;
	cleanup(): void;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-cli-"));
	const workspace = join(root, "workspace");
	const dir = join(root, "reactor");
	// An empty agent dir of our own: `resume` globs pi's session directory, and a
	// test that reads the developer's real one passes or fails by accident.
	const agentDir = join(root, "agent");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(agentDir, "sessions"), { recursive: true });
	writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: {} }));

	return {
		paths: resolvePaths({ PI_REACTOR_DIR: dir }),
		workspace,
		agentDir,
		async cli(...argv) {
			const { stdout } = await run(process.execPath, [CLI, ...argv], {
				env: { ...process.env, PI_REACTOR_DIR: dir, PI_CODING_AGENT_DIR: agentDir },
			});
			return stdout;
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

async function withDaemon(f: Fixture, fn: () => Promise<void>): Promise<void> {
	const daemon = await serve({ paths: f.paths, logger: quiet, installSignalHandlers: false, workerTickMs: 50, shutdownGraceMs: 2000 });
	try {
		await fn();
	} finally {
		await daemon.stop();
	}
}

test("--extension may be given more than once, and every one reaches the agent", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await f.cli(
				"agent", "add", "news",
				"--cwd", f.workspace,
				"--model", "sub2api/gpt-5.6",
				"--extension", "/root/.pi/agent/npm/node_modules/pi-sub2api/src/index.ts",
				"--extension", "/root/.pi/agent/npm/node_modules/other/index.ts",
			);

			// Read it back through the daemon rather than trusting the write: this is
			// the value the runner will turn into `-e` arguments.
			const agents = JSON.parse(await f.cli("agent", "ls")) as Array<{ name: string; extensions: string[] }>;
			const stored = agents.find((a) => a.name === "news");

			assert.ok(stored, "the agent was created");
			assert.deepEqual(stored.extensions, [
				"/root/.pi/agent/npm/node_modules/pi-sub2api/src/index.ts",
				"/root/.pi/agent/npm/node_modules/other/index.ts",
			], "both, in the order given — pi loads them in that order too");
		});
	} finally {
		f.cleanup();
	}
});

test("edit changes only what is passed, and leaves the rest alone", async () => {
	// The daemon replaces the whole entry, so an edit that forwarded only the
	// given flags would drop cwd and model — and adding an extension to an
	// existing agent is the case people reach for edit to do. This is how that
	// gap was found: `agent add` refuses with "use agent.edit", which the CLI
	// did not have, leaving a restart as the only way through.
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await f.cli("agent", "add", "news", "--cwd", f.workspace, "--model", "prov/m", "--extension", "/ext/a.ts");
			await f.cli("agent", "edit", "news", "--extension", "/ext/a.ts", "--extension", "/ext/b.ts");

			const [agent] = JSON.parse(await f.cli("agent", "ls")) as {
				cwd: string;
				provider: string;
				modelId: string;
				extensions: string[];
			}[];
			assert.deepEqual(agent!.extensions, ["/ext/a.ts", "/ext/b.ts"]);
			assert.equal(agent!.cwd, f.workspace, "cwd survived an edit that never mentioned it");
			assert.equal(`${agent!.provider}/${agent!.modelId}`, "prov/m");
		});
	} finally {
		f.cleanup();
	}
});

test("edit refuses a name that is not there", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await assert.rejects(() => f.cli("agent", "edit", "ghost", "--model", "prov/m"), /no agent "ghost"/);
		});
	} finally {
		f.cleanup();
	}
});

test("edit --dry-run shows the change without applying it", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await f.cli("agent", "add", "news", "--cwd", f.workspace, "--model", "prov/m");
			const preview = await f.cli("agent", "edit", "news", "--model", "prov/other", "--dry-run");
			assert.match(preview, /would write/);
			assert.match(preview, /other/);

			const [agent] = JSON.parse(await f.cli("agent", "ls")) as { modelId: string }[];
			assert.equal(agent!.modelId, "m", "a dry run must not have written");
		});
	} finally {
		f.cleanup();
	}
});

// ---------------------------------------------------------------- resume
//
// Resolution is a directory glob over pi's own session files, so none of the
// happy paths need a daemon — which is the point: an interrupted run must be
// resumable after the daemon died.

interface SessionsFixture {
	agentDir: string;
	cli(...argv: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
	cleanup(): void;
}

function sessionsFixture(): SessionsFixture {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-resume-"));
	const agentDir = join(root, "agent");
	const project = join(agentDir, "sessions", "--tmp-work--");
	mkdirSync(project, { recursive: true });

	const header = (cwd: string): string =>
		`${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd })}\n`;
	writeFileSync(
		join(project, "2026-08-03T09-00-04-118Z_019f9951-a6b5-7204-80f6-cfb098998b0b.jsonl"),
		header("/tmp/work"),
	);
	writeFileSync(
		join(project, "2026-08-03T08-00-04-118Z_019f9951-ffff-7204-80f6-cfb098998b0b.jsonl"),
		header("/tmp/work"),
	);
	// `pi --session-id my-feature` is legal (assertValidSessionId), so resume has
	// to see it too — a uuid-shaped filter would hide every named session. The
	// pair also pins pi's exact-before-prefix rule: `my-feature` is both an id
	// and a prefix of `my-feature-2`.
	writeFileSync(join(project, "2026-08-03T07-00-04-118Z_my-feature.jsonl"), header("/tmp/work"));
	writeFileSync(join(project, "2026-08-03T06-00-04-118Z_my-feature-2.jsonl"), header("/tmp/work"));

	return {
		agentDir,
		async cli(...argv) {
			return new Promise((resolve) => {
				execFile(
					process.execPath,
					[CLI, ...argv],
					{ env: { ...process.env, PI_REACTOR_DIR: join(root, "reactor"), PI_CODING_AGENT_DIR: agentDir } },
					(err, stdout, stderr) => resolve({ stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
				);
			});
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("resume resolves a unique session prefix from the local files, no daemon needed", async () => {
	const f = sessionsFixture();
	try {
		const { stdout, code } = await f.cli("resume", "019f9951-a6b5", "--print");
		assert.equal(code, 0);
		assert.match(stdout.trim(), /_019f9951-a6b5-7204-80f6-cfb098998b0b\.jsonl$/);
	} finally {
		f.cleanup();
	}
});

test("resume matches prefixes exactly like pi does — no case folding, no fuzz", async () => {
	// An earlier version folded case and ignored hyphens. That made the CLI more
	// permissive than pi (main.js:124 is a plain startsWith) and than the
	// daemon's own lookup, and it let `my-feature` and `myfeature` collide.
	const f = sessionsFixture();
	try {
		const upper = await f.cli("resume", "019F9951-A6B5", "--print");
		assert.notEqual(upper.code, 0, "uppercase is a different prefix, as it is for pi");
		const dehyphenated = await f.cli("resume", "019f9951a6b5", "--print");
		assert.notEqual(dehyphenated.code, 0, "hyphens are part of the id, not decoration");
	} finally {
		f.cleanup();
	}
});

test("resume prefers an exact id over the longer sessions it prefixes", async () => {
	// pi's rule (main.js:124): `id === arg` before `id.startsWith(arg)`, so a
	// session whose whole name is a prefix of another still opens itself.
	const f = sessionsFixture();
	try {
		const { stdout, code } = await f.cli("resume", "my-feature", "--print");
		assert.equal(code, 0, "unambiguous by pi's rule, even though my-feature-2 also starts with it");
		assert.match(stdout.trim(), /_my-feature\.jsonl$/);
	} finally {
		f.cleanup();
	}
});

test("resume finds a named session, not just uuid-shaped ones", async () => {
	const f = sessionsFixture();
	try {
		// `my-feat` is a prefix of two, so it is ambiguous — which is itself the
		// proof that named sessions are visible at all.
		const { stderr, code } = await f.cli("resume", "my-feat", "--print");
		assert.notEqual(code, 0);
		assert.match(stderr, /matches 2 sessions/);
		assert.match(stderr, /my-feature/);
	} finally {
		f.cleanup();
	}
});

test("resume refuses an ambiguous prefix and lists the candidates", async () => {
	// A UUIDv7 prefix is timestamp, not entropy: two sessions started close
	// together share a long prefix, so refusing beats guessing.
	const f = sessionsFixture();
	try {
		const { stderr, code } = await f.cli("resume", "019f9951", "--print");
		assert.notEqual(code, 0);
		assert.match(stderr, /matches 2 sessions/);
		assert.match(stderr, /019f9951-a6b5/);
		assert.match(stderr, /019f9951-ffff/);
	} finally {
		f.cleanup();
	}
});

test("resume tells an old run number apart from a session id", async () => {
	const f = sessionsFixture();
	try {
		const { stderr, code } = await f.cli("resume", "13", "--print");
		assert.notEqual(code, 0);
		assert.match(stderr, /session id now, not by run number/);
	} finally {
		f.cleanup();
	}
});

test("resume falls back to the daemon for a session outside the default directory", async () => {
	// pi's `sessionDir` setting is cwd-bound, so a project-local one writes where
	// the glob cannot see. The daemon holds the path pi reported; without this
	// fallback the notification's own link would dead-end for those agents.
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			const db = openDb(f.paths.db);
			try {
				const elsewhere = join(f.workspace, "custom_019fabcd-1111-7000-8000-000000000000.jsonl");
				writeFileSync(
					elsewhere,
					`${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: f.workspace })}\n`,
				);
				db.prepare(
					`INSERT INTO runs (agent, session_id, session_file, outcome, started_at)
					 VALUES ('a', '019fabcd-1111-7000-8000-000000000000', ?, 'succeeded', ?)`,
				).run(elsewhere, new Date().toISOString());
			} finally {
				db.close();
			}

			// PI_CODING_AGENT_DIR points at an empty tree, so the glob finds nothing.
			const out = await f.cli("resume", "019fabcd", "--print");
			assert.equal(out.trim(), join(f.workspace, "custom_019fabcd-1111-7000-8000-000000000000.jsonl"));
		});
	} finally {
		f.cleanup();
	}
});

test("an ambiguous prefix is judged across both sources, not just the local one", async () => {
	// The bug this pins: a lone local hit used to be taken as unique without
	// asking the daemon, so a same-prefix session in a custom sessionDir made
	// resume open the wrong conversation, silently. A full id still
	// short-circuits (ids are unique) — only a partial prefix merges.
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			const localDir = join(f.agentDir, "sessions", "--work--");
			mkdirSync(localDir, { recursive: true });
			const header = `${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: f.workspace })}\n`;
			writeFileSync(join(localDir, "2026-08-04T00-00-00-000Z_019fabcd-1111-7000-8000-000000000000.jsonl"), header);

			const elsewhere = join(f.workspace, "custom_019fabcd-2222-7000-8000-000000000000.jsonl");
			writeFileSync(elsewhere, header);
			const db = openDb(f.paths.db);
			try {
				db.prepare(
					`INSERT INTO runs (agent, session_id, session_file, outcome, started_at)
					 VALUES ('a', '019fabcd-2222-7000-8000-000000000000', ?, 'succeeded', ?)`,
				).run(elsewhere, new Date().toISOString());
			} finally {
				db.close();
			}

			await assert.rejects(() => f.cli("resume", "019fabcd", "--print"), /matches 2 sessions/);

			// The full id is still unambiguous and resolves without complaint.
			const out = await f.cli("resume", "019fabcd-2222-7000-8000-000000000000", "--print");
			assert.equal(out.trim(), elsewhere);
		});
	} finally {
		f.cleanup();
	}
});

test("resume with no argument is the queue switch, the symmetry partner of pause", async () => {
	// This exact dispatch was dead code for a while: the session case shadowed
	// the queue switch, so `pi-reactor resume` printed a usage error instead of
	// un-pausing.
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await f.cli("pause");
			const out = await f.cli("resume");
			assert.equal(out.trim(), "queue resumed");
		});
	} finally {
		f.cleanup();
	}
});

test("trigger edit keeps the parts of the trigger it was not given", async () => {
	const f = fixture();
	try {
		await withDaemon(f, async () => {
			await f.cli("agent", "add", "news", "--cwd", f.workspace, "--model", "prov/m");
			await f.cli("sink", "add", "tg", "--kind", "telegram", "--chat-id", "1");
			await f.cli("trigger", "add", "nightly", "--schedule", "0 9 * * *", "--timezone", "Asia/Shanghai", "--agent", "news", "--task", "do the thing", "--notify", "tg");

			await f.cli("trigger", "edit", "nightly", "--schedule", "15 12 * * *");

			// `ls` reports the normalised runtime view, which is a different shape
			// from the on-disk entry `edit` writes — hoisted id/schedule, defaults
			// filled in. Asserting against it is the point: it is what the daemon
			// actually ended up holding.
			const [trigger] = JSON.parse(await f.cli("trigger", "ls")) as {
				schedule: string;
				timezone?: string;
				run: { task: string };
				notify?: { sink: string };
			}[];
			assert.equal(trigger!.schedule, "15 12 * * *");
			assert.equal(trigger!.timezone, "Asia/Shanghai", "timezone was not mentioned, so it stays");
			assert.equal(trigger!.run.task, "do the thing");
			assert.equal(trigger!.notify?.sink, "tg");
		});
	} finally {
		f.cleanup();
	}
});

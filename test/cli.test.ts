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
import { createLogger } from "../src/daemon/logger.ts";
import { serve } from "../src/daemon/serve.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const quiet = createLogger({ level: "error", write: () => {} });

interface Fixture {
	paths: Paths;
	workspace: string;
	cli(...argv: string[]): Promise<string>;
	cleanup(): void;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-cli-"));
	const workspace = join(root, "workspace");
	const dir = join(root, "reactor");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: {} }));

	return {
		paths: resolvePaths({ PI_REACTOR_DIR: dir }),
		workspace,
		async cli(...argv) {
			const { stdout } = await run(process.execPath, [CLI, ...argv], {
				env: { ...process.env, PI_REACTOR_DIR: dir },
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

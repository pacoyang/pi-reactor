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

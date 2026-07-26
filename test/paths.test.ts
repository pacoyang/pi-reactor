import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { resolvePaths, ensureDirs } from "../src/core/paths.ts";

test("defaults to ~/.pi-reactor: one directory, not the XDG three-way split", () => {
	const p = resolvePaths({});
	assert.equal(p.root, join(homedir(), ".pi-reactor"));
	for (const f of [p.agentsFile, p.credentialsFile, p.db, p.sock, p.pidFile]) {
		assert.equal(dirname(f), p.root, `${f} should sit directly under the root`);
	}
});

test("PI_REACTOR_DIR overrides, mirroring PI_CODING_AGENT_DIR", () => {
	const p = resolvePaths({ PI_REACTOR_DIR: "/tmp/custom-reactor" });
	assert.equal(p.root, "/tmp/custom-reactor");
	assert.equal(p.db, "/tmp/custom-reactor/state.db");
	assert.equal(resolvePaths({ PI_REACTOR_DIR: "  " }).root, join(homedir(), ".pi-reactor"), "whitespace counts as unset");
});

test("file names never repeat the app name: the directory is already named", () => {
	const p = resolvePaths({ PI_REACTOR_DIR: "/tmp/x" });
	const names = [p.agentsFile, p.sinksFile, p.triggersFile, p.credentialsFile, p.db, p.sock, p.pidFile].map((f) => basename(f));
	assert.deepEqual(names, ["agents.json", "sinks.json", "triggers.json", "credentials.json", "state.db", "daemon.sock", "daemon.pid"]);
	for (const n of names) {
		assert.ok(!n.includes("reactor"), `${n} should not repeat the app name`);
	}
});

test("ensureDirs is idempotent and creates a 0700 root (credentials and queue live there)", () => {
	const base = mkdtempSync(join(tmpdir(), "pi-reactor-paths-"));
	try {
		const p = resolvePaths({ PI_REACTOR_DIR: join(base, "nested", "dir") });
		ensureDirs(p);
		ensureDirs(p); // idempotent
		assert.equal(statSync(p.root).mode & 0o777, 0o700);
		assert.equal(existsSync(join(p.root, "logs")), false,
			"logs go to stdout for the process manager to own; a logs/ dir would promise otherwise");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

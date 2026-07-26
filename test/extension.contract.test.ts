/**
 * Contract test for the operator console: does the REAL pi extension loader
 * accept our extension, and does it register what we claim?
 *
 * The rest of the console's behaviour is covered by console.integration.test.ts
 * against the daemon socket. What only pi can answer is whether the module shape,
 * the tool schemas and the command registration are actually valid — every one of
 * those is an assumption about an upstream API with no semver promise, which is
 * exactly what a contract test is for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "src", "extension", "index.ts");

test("contract E1: pi loads the console and registers its tools and command", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-ext-"));
	try {
		const result = await discoverAndLoadExtensions([EXTENSION], root, join(root, "agent"));

		assert.deepEqual(result.errors, [], "a load error here means the extension is dead on arrival in a real session");
		assert.equal(result.extensions.length, 1);

		const extension = result.extensions[0];
		assert.ok(extension);

		const tools = [...extension.tools.keys()].sort();
		assert.deepEqual(
			tools,
			["reactor_config_get", "reactor_config_set", "reactor_emit", "reactor_pause", "reactor_runs", "reactor_status"],
			"the reactor_* tool set is what the skill instructs the model to call",
		);

		assert.ok(extension.commands.has("reactor"), "/reactor is the operator's entry point");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("contract E2: every tool declares a schema pi can validate against", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-ext-"));
	try {
		const result = await discoverAndLoadExtensions([EXTENSION], root, join(root, "agent"));
		const extension = result.extensions[0];
		assert.ok(extension);

		for (const [name, tool] of extension.tools) {
			const definition = (tool as { definition?: { parameters?: unknown; description?: string } }).definition ?? tool;
			const spec = definition as { parameters?: { type?: string }; description?: string };
			assert.equal(spec.parameters?.type, "object", `${name} must take an object parameter schema`);
			assert.ok((spec.description ?? "").length > 40, `${name} needs a description the model can route on`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("contract E3: `-ne` keeps the console out of a batch job", async () => {
	// This is the whole of the unattended-safety argument: a job never loads the
	// console, so its write tools cannot be reached without a human. If pi ever
	// stopped honouring noExtensions for explicit paths, that argument would fail
	// silently — hence a test rather than a comment.
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-ext-"));
	try {
		const result = await discoverAndLoadExtensions([], root, join(root, "agent"));
		assert.deepEqual(result.extensions, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("contract E4: the console loads from a copy of the shipped tree, not just from the repo", async () => {
	// `pi install npm:pi-reactor` unpacks the package somewhere else entirely, so
	// the console has to work from `src/extension/index.ts` inside a copied tree —
	// its `../core/*` imports and all. An extension that only loads from a checkout
	// is one that works for its author and nobody else.
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-ext-"));
	try {
		const installed = join(root, "node_modules", "pi-reactor");
		mkdirSync(installed, { recursive: true });
		cpSync(join(HERE, "..", "src"), join(installed, "src"), { recursive: true });
		cpSync(join(HERE, "..", "package.json"), join(installed, "package.json"));

		const entry = join(installed, "src", "extension", "index.ts");
		const result = await discoverAndLoadExtensions([entry], root, join(root, "agent"));

		assert.deepEqual(result.errors, [], "a relative import that only resolves in the repo would surface here");
		assert.equal(result.extensions.length, 1);
		assert.ok(result.extensions[0]?.tools.has("reactor_status"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

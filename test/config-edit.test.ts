/**
 * Config mutation: validate-before-write, atomicity, and the referential
 * integrity that makes "the daemon owns the files" worth anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, type Paths } from "../src/core/paths.ts";
import { ConfigError } from "../src/core/config.ts";
import {
	previewEdit,
	applyEdit,
	addTrigger,
	editTrigger,
	deleteTrigger,
	addAgent,
	editAgent,
	deleteAgent,
	addSink,
	setCredential,
	listCredentialFields,
} from "../src/core/config-edit.ts";

interface Env {
	paths: Paths;
	cwd: string;
	cleanup(): void;
}

/** A configured daemon directory: one agent, one sink, no triggers. */
function env(seed = true): Env {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-edit-"));
	const dir = join(root, "reactor");
	const cwd = join(root, "work");
	mkdirSync(dir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const paths = resolvePaths({ PI_REACTOR_DIR: dir });
	if (seed) {
		writeFileSync(paths.agentsFile, JSON.stringify({ agents: { report: { cwd, model: "stub/model" } } }));
		writeFileSync(paths.sinksFile, JSON.stringify({ sinks: { tg: { kind: "telegram", chatId: 1 } } }));
	}
	return { paths, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function cronTrigger(id: string, schedule = "0 9 * * *"): Record<string, unknown> {
	return {
		on: { type: "cron", id, schedule, timezone: "UTC" },
		run: { agent: "report", task: "summarise" },
		notify: { sink: "tg", when: "always" },
	};
}

test("a dry run validates and shows before -> after, and writes nothing", () => {
	const e = env();
	try {
		const { preview } = previewEdit(e.paths, addTrigger(cronTrigger("nightly")));

		assert.equal(preview.changed, true);
		assert.match(preview.after, /"nightly"/);
		assert.doesNotMatch(preview.before, /nightly/);
		assert.equal(existsSync(e.paths.triggersFile), false,
			"the gate must be able to show a validated result without committing to it");
	} finally {
		e.cleanup();
	}
});

test("an invalid edit is refused BEFORE anything is written", () => {
	const e = env();
	try {
		// Nothing on disk yet, so a rejected first write would be invisible; assert
		// on the file staying absent as well as on the throw.
		assert.throws(() => applyEdit(e.paths, addTrigger(cronTrigger("bad", "77 * * * *"))), ConfigError);
		assert.equal(existsSync(e.paths.triggersFile), false);

		applyEdit(e.paths, addTrigger(cronTrigger("good")));
		const written = readFileSync(e.paths.triggersFile, "utf8");
		assert.throws(() => applyEdit(e.paths, addTrigger(cronTrigger("also-bad", "* * * * * * *"))), ConfigError);
		assert.equal(readFileSync(e.paths.triggersFile, "utf8"), written,
			"a rejected edit is a no-op, not something to roll back");
	} finally {
		e.cleanup();
	}
});

test("validation spans all three documents, not just the edited one", () => {
	const e = env();
	try {
		// A trigger names an agent and a sink, so triggers.json alone cannot answer
		// whether a trigger is valid.
		assert.throws(
			() => applyEdit(e.paths, addTrigger({ on: { type: "cron", id: "x", schedule: "0 9 * * *" }, run: { agent: "ghost", task: "t" } })),
			/ghost/,
		);

		applyEdit(e.paths, addTrigger(cronTrigger("nightly")));
		assert.throws(() => applyEdit(e.paths, deleteAgent("report")), /report/,
			"deleting something still in use is a mistake, not a cascade");
	} finally {
		e.cleanup();
	}
});

test("add refuses to overwrite and edit refuses to create", () => {
	const e = env();
	try {
		assert.throws(() => applyEdit(e.paths, addAgent("report", { cwd: e.cwd, model: "stub/m" })), /already exists/,
			"a typo in a name is a mistake, not a new entry");
		assert.throws(() => applyEdit(e.paths, editAgent("typo", { cwd: e.cwd, model: "stub/m" })), /no agent "typo"/);

		applyEdit(e.paths, addTrigger(cronTrigger("nightly")));
		assert.throws(() => applyEdit(e.paths, addTrigger(cronTrigger("nightly"))), /already exists/);
		assert.throws(() => applyEdit(e.paths, deleteTrigger("absent")), /no trigger "absent"/);
	} finally {
		e.cleanup();
	}
});

test("edit replaces an entry wholesale and refuses to rename it", () => {
	const e = env();
	try {
		applyEdit(e.paths, addTrigger(cronTrigger("nightly")));

		const moved = cronTrigger("nightly", "0 10 * * *");
		applyEdit(e.paths, editTrigger("nightly", moved));
		const doc = JSON.parse(readFileSync(e.paths.triggersFile, "utf8")) as { triggers: Array<{ on: { schedule: string } }> };
		assert.equal(doc.triggers.length, 1);
		assert.equal(doc.triggers[0]?.on.schedule, "0 10 * * *");

		assert.throws(() => applyEdit(e.paths, editTrigger("nightly", cronTrigger("renamed"))), /cannot rename/,
			"a rename through edit would silently orphan whatever referred to the old id");
	} finally {
		e.cleanup();
	}
});

test("an unchanged edit reports no change rather than rewriting the file", () => {
	const e = env();
	try {
		applyEdit(e.paths, addTrigger(cronTrigger("nightly")));
		const before = statSync(e.paths.triggersFile).mtimeMs;
		const preview = applyEdit(e.paths, editTrigger("nightly", cronTrigger("nightly")));
		assert.equal(preview.changed, false);
		assert.equal(statSync(e.paths.triggersFile).mtimeMs, before);
	} finally {
		e.cleanup();
	}
});

test("an empty directory is a valid configuration: the console has to start somewhere", () => {
	const e = env(false);
	try {
		// The loader used to refuse to start without at least one agent, which
		// made the conversational path impossible to bootstrap: you cannot configure
		// through a daemon that will not run until it is configured.
		applyEdit(e.paths, addAgent("report", { cwd: e.cwd, model: "stub/model" }));
		applyEdit(e.paths, addSink("tg", { kind: "telegram", chatId: 7 }));
		const preview = applyEdit(e.paths, addTrigger(cronTrigger("nightly")));

		assert.equal(preview.changed, true);
		assert.match(readFileSync(e.paths.agentsFile, "utf8"), /report/);
		assert.match(readFileSync(e.paths.triggersFile, "utf8"), /nightly/);
	} finally {
		e.cleanup();
	}
});

test("a config file that is not valid JSON is left alone", () => {
	const e = env();
	try {
		writeFileSync(e.paths.triggersFile, "{ half a document");
		assert.throws(() => applyEdit(e.paths, addTrigger(cronTrigger("nightly"))), /not valid JSON/);
		assert.equal(readFileSync(e.paths.triggersFile, "utf8"), "{ half a document",
			"patching a document we cannot parse would discard whatever was being written");
	} finally {
		e.cleanup();
	}
});

test("credentials go to their own 0600 file and are never echoed back", () => {
	const e = env();
	try {
		setCredential(e.paths, "tg", "botToken", "123:SECRET");
		assert.equal(statSync(e.paths.credentialsFile).mode & 0o777, 0o600);
		assert.deepEqual(listCredentialFields(e.paths, "tg"), ["botToken"],
			"the listing names the fields that exist, never their values");

		// A second field merges rather than replacing the entry.
		setCredential(e.paths, "tg", "extra", "x");
		assert.deepEqual(listCredentialFields(e.paths, "tg").sort(), ["botToken", "extra"]);

		// And nothing about it leaks into the documents the confirmation gate shows.
		for (const file of [e.paths.agentsFile, e.paths.sinksFile]) {
			assert.doesNotMatch(readFileSync(file, "utf8"), /SECRET/);
		}
		assert.throws(() => setCredential(e.paths, "tg", "botToken", ""), /must not be empty/);
	} finally {
		e.cleanup();
	}
});

test("a write leaves no temp file behind, even when it fails", () => {
	const e = env();
	try {
		applyEdit(e.paths, addTrigger(cronTrigger("nightly")));
		assert.throws(() => applyEdit(e.paths, addTrigger(cronTrigger("nightly"))));
		const leftovers = readFileSync(e.paths.triggersFile, "utf8");
		assert.match(leftovers, /nightly/);

		const stray = readdirSync(e.paths.root).filter((f: string) => f.endsWith(".tmp"));
		assert.deepEqual(stray, [], "a rename-based write must not litter the config directory");
	} finally {
		e.cleanup();
	}
});

/**
 * Config mutation: read, apply, validate, write atomically.
 *
 * Every configuration change in the system funnels through here, because the
 * daemon owns the config files outright. The pi extension is a thin client
 * that sends JSON-RPC; it never touches a file. That is what keeps validation,
 * atomic writing and hot reload implemented exactly once instead of once per
 * caller — and it is why an old extension talking to a new daemon degrades to a
 * plain `-32601` rather than writing something the daemon would reject.
 *
 * Split from config.ts on the same reasoning that put job-env.ts beside
 * agent-runner.ts: config.ts is imported by the worker, scheduler and relay on
 * their hot paths and only ever reads. Mutation is needed by one caller.
 *
 * Naming: pi's nearest analogue is `core/settings-manager.ts`, but "manager"
 * there covers scopes and cross-process locking as well as writing. Ours does
 * neither — the daemon is the sole writer — so the module is named for what it
 * actually is.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, statSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseAgents, parseSinks, parseTriggers, ConfigError, type Config } from "./config.ts";
import type { Paths } from "./paths.ts";

export type JsonObject = Record<string, unknown>;

/** Which of the three config documents an edit touches. */
export type DocName = "agents" | "sinks" | "triggers";

export interface Edit {
	doc: DocName;
	/** One line for the log; never contains a credential. */
	summary: string;
	/** Pure: takes the current document and returns the new one. */
	apply(current: JsonObject): JsonObject;
}

export interface EditPreview {
	doc: DocName;
	file: string;
	/** Rendered documents, for the confirmation gate to show before -> after. */
	before: string;
	after: string;
	changed: boolean;
}

/** Empty shape of each document, used when the file does not exist yet. */
const EMPTY: Record<DocName, JsonObject> = {
	agents: { agents: {} },
	sinks: { sinks: {} },
	triggers: { triggers: [] },
};

function fileFor(paths: Paths, doc: DocName): string {
	return doc === "agents" ? paths.agentsFile : doc === "sinks" ? paths.sinksFile : paths.triggersFile;
}

function readDocument(file: string, doc: DocName): JsonObject {
	if (!existsSync(file)) return structuredClone(EMPTY[doc]);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (cause) {
		throw new ConfigError(`cannot read ${file}`, { cause });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		// Refusing to edit a file we cannot parse is deliberate: applying a patch
		// to a document we do not understand would silently discard whatever the
		// operator was in the middle of writing.
		throw new ConfigError(`${file} is not valid JSON; fix it by hand before editing through the daemon`, { cause });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ConfigError(`${file} must contain a JSON object`);
	}
	return parsed as JsonObject;
}

/** Two-space JSON with a trailing newline — the shape every hand-edited file here already has. */
function render(doc: JsonObject): string {
	return `${JSON.stringify(doc, null, "\t")}\n`;
}

/**
 * Validates a complete candidate configuration.
 *
 * All three documents together, never just the edited one: a trigger names an
 * agent and a sink, so "is this trigger valid" is not answerable from
 * triggers.json alone. This runs BEFORE anything is written, which is what makes
 * a rejected edit a no-op rather than something to roll back.
 */
function validateCandidate(paths: Paths, docs: Record<DocName, JsonObject>): Config {
	const agents = parseAgents(docs.agents, paths.agentsFile);
	const sinks = parseSinks(docs.sinks, paths.sinksFile);
	const triggers = parseTriggers(docs.triggers, paths.triggersFile, agents, sinks);
	return { agents, sinks, triggers };
}

function currentDocuments(paths: Paths): Record<DocName, JsonObject> {
	return {
		agents: readDocument(paths.agentsFile, "agents"),
		sinks: readDocument(paths.sinksFile, "sinks"),
		triggers: readDocument(paths.triggersFile, "triggers"),
	};
}

/**
 * Applies an edit in memory and validates the result. Writes nothing.
 *
 * The extension calls this to fill its confirmation gate, so what the operator
 * approves is a document already known to be valid — showing an "after" that the
 * daemon would then reject is worse than showing nothing.
 */
export function previewEdit(paths: Paths, edit: Edit): { preview: EditPreview; config: Config } {
	const docs = currentDocuments(paths);
	const before = docs[edit.doc];
	const after = edit.apply(structuredClone(before));
	const config = validateCandidate(paths, { ...docs, [edit.doc]: after });

	const beforeText = render(before);
	const afterText = render(after);
	return {
		preview: {
			doc: edit.doc,
			file: fileFor(paths, edit.doc),
			before: beforeText,
			after: afterText,
			changed: beforeText !== afterText,
		},
		config,
	};
}

/** Validates, then writes. Returns the same preview the caller could have seen first. */
export function applyEdit(paths: Paths, edit: Edit): EditPreview {
	const { preview } = previewEdit(paths, edit);
	if (preview.changed) writeAtomic(preview.file, preview.after);
	return preview;
}

/**
 * Write via a sibling temp file and rename.
 *
 * rename(2) within a directory is atomic, so a reader — the daemon reloading, or
 * an operator with the file open — sees either the old document or the new one,
 * never a half-written file. The temp file must be a sibling: rename is only
 * atomic within one filesystem.
 *
 * There is deliberately no lock. pi reaches for `proper-lockfile` around its
 * settings because several pi processes edit the same file; here the daemon is
 * the only writer by construction. An operator editing by hand at the same
 * instant can still lose their change — but they are sitting right there, and a
 * dependency plus a lock file is a poor trade for that window.
 */
export function writeAtomic(file: string, contents: string, mode?: number): void {
	const temp = join(dirname(file), `.${Date.now()}.${process.pid}.tmp`);
	const finalMode = mode ?? (existsSync(file) ? statSync(file).mode & 0o777 : 0o644);
	try {
		writeFileSync(temp, contents, { mode: finalMode });
		// writeFileSync's mode is only applied when it CREATES the file, and umask
		// applies to that; set it explicitly so the rename lands the mode we meant.
		chmodSync(temp, finalMode);
		renameSync(temp, file);
	} catch (err) {
		try {
			if (existsSync(temp)) unlinkSync(temp);
		} catch {
			// Best effort; the failure that matters is the one below.
		}
		throw err;
	}
}

// ---------------------------------------------------------------- operations

function triggerList(doc: JsonObject): JsonObject[] {
	const list = doc.triggers;
	if (list === undefined) return [];
	if (!Array.isArray(list)) throw new ConfigError(`"triggers" must be an array`);
	return list as JsonObject[];
}

function triggerId(entry: unknown): string | undefined {
	const on = (entry as JsonObject | undefined)?.on;
	const id = (on as JsonObject | undefined)?.id;
	return typeof id === "string" ? id : undefined;
}

export function addTrigger(entry: JsonObject): Edit {
	const id = triggerId(entry) ?? "(no id)";
	return {
		doc: "triggers",
		summary: `add trigger "${id}"`,
		apply(current) {
			const list = triggerList(current);
			if (list.some((t) => triggerId(t) === id)) {
				throw new ConfigError(`trigger "${id}" already exists; use trigger.edit to change it`);
			}
			return { ...current, triggers: [...list, entry] };
		},
	};
}

/**
 * Replaces a trigger wholesale rather than patching it.
 *
 * A patch would have to define how to merge nested `on` / `run` / `notify`
 * objects, and every answer is surprising for some field. Read the entry, change
 * it, send it back: the same shape as editing a file, and the before -> after
 * gate shows exactly what moved.
 */
export function editTrigger(id: string, entry: JsonObject): Edit {
	return {
		doc: "triggers",
		summary: `edit trigger "${id}"`,
		apply(current) {
			const list = triggerList(current);
			const index = list.findIndex((t) => triggerId(t) === id);
			if (index === -1) throw new ConfigError(`no trigger "${id}"`);
			const replacementId = triggerId(entry);
			if (replacementId !== id) {
				throw new ConfigError(`trigger.edit cannot rename "${id}" to "${replacementId ?? "(no id)"}"; delete and add instead`);
			}
			const next = [...list];
			next[index] = entry;
			return { ...current, triggers: next };
		},
	};
}

export function deleteTrigger(id: string): Edit {
	return {
		doc: "triggers",
		summary: `delete trigger "${id}"`,
		apply(current) {
			const list = triggerList(current);
			if (!list.some((t) => triggerId(t) === id)) throw new ConfigError(`no trigger "${id}"`);
			return { ...current, triggers: list.filter((t) => triggerId(t) !== id) };
		},
	};
}

function namedMap(doc: JsonObject, key: "agents" | "sinks"): JsonObject {
	const map = doc[key];
	if (map === undefined) return {};
	if (typeof map !== "object" || map === null || Array.isArray(map)) {
		throw new ConfigError(`"${key}" must be a JSON object`);
	}
	return map as JsonObject;
}

/** `add` refuses to overwrite and `edit` refuses to create: a typo in a name is a mistake, not a new entry. */
function namedEdit(kind: "agents" | "sinks", mode: "add" | "edit", name: string, spec: JsonObject): Edit {
	const noun = kind === "agents" ? "agent" : "sink";
	return {
		doc: kind,
		summary: `${mode} ${noun} "${name}"`,
		apply(current) {
			const map = namedMap(current, kind);
			const exists = Object.hasOwn(map, name);
			if (mode === "add" && exists) {
				throw new ConfigError(`${noun} "${name}" already exists; use ${noun}.edit to change it`);
			}
			if (mode === "edit" && !exists) {
				throw new ConfigError(`no ${noun} "${name}"`);
			}
			return { ...current, [kind]: { ...map, [name]: spec } };
		},
	};
}

export const addAgent = (name: string, spec: JsonObject): Edit => namedEdit("agents", "add", name, spec);
export const editAgent = (name: string, spec: JsonObject): Edit => namedEdit("agents", "edit", name, spec);
export const addSink = (name: string, spec: JsonObject): Edit => namedEdit("sinks", "add", name, spec);
export const editSink = (name: string, spec: JsonObject): Edit => namedEdit("sinks", "edit", name, spec);

function namedDelete(kind: "agents" | "sinks", name: string): Edit {
	const noun = kind === "agents" ? "agent" : "sink";
	return {
		doc: kind,
		summary: `delete ${noun} "${name}"`,
		apply(current) {
			const map = namedMap(current, kind);
			if (!Object.hasOwn(map, name)) throw new ConfigError(`no ${noun} "${name}"`);
			const next = { ...map };
			delete next[name];
			// A trigger still pointing here makes validation fail, which is the
			// intended answer: deleting something in use is a mistake, not a cascade.
			return { ...current, [kind]: next };
		},
	};
}

export const deleteAgent = (name: string): Edit => namedDelete("agents", name);
export const deleteSink = (name: string): Edit => namedDelete("sinks", name);

// ---------------------------------------------------------------- credentials

/**
 * Writes one credential into credentials.json at 0600.
 *
 * Separate from the config documents on purpose: credentials never enter a
 * config file, so the confirmation gate can display those files in full, and a
 * secret never reaches the model's context. Nothing here is ever echoed back to
 * the caller — the return value says only that a value is now present.
 */
export function setCredential(paths: Paths, name: string, field: string, value: string): void {
	if (value === "") throw new ConfigError("credential value must not be empty");
	let current: JsonObject = {};
	if (existsSync(paths.credentialsFile)) {
		try {
			const parsed = JSON.parse(readFileSync(paths.credentialsFile, "utf8")) as unknown;
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) current = parsed as JsonObject;
		} catch (cause) {
			throw new ConfigError(`${paths.credentialsFile} is not valid JSON; fix it by hand first`, { cause });
		}
	}
	const entry = current[name];
	const merged = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? { ...(entry as JsonObject) } : {};
	merged[field] = value;
	writeAtomic(paths.credentialsFile, render({ ...current, [name]: merged }), 0o600);
}

/** Which credential fields exist for a name, values never included. */
export function listCredentialFields(paths: Paths, name: string): string[] {
	if (!existsSync(paths.credentialsFile)) return [];
	try {
		const parsed = JSON.parse(readFileSync(paths.credentialsFile, "utf8")) as JsonObject;
		const entry = parsed[name];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
		return Object.keys(entry as JsonObject);
	} catch {
		return [];
	}
}

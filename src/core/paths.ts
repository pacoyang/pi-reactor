/**
 * Single-directory layout.
 *
 * One `~/.pi-reactor/` holds config, state and runtime — the same shape as pi
 * (`~/.pi/agent/`) and Claude Code (`~/.claude/`, which likewise contains
 * daemon/ and jobs/), rather than the XDG three-way split. The payoff is one
 * operation each for backup, migration and uninstall; the cost (a naive backup
 * includes the database) is the same one pi lives with for its sessions/.
 *
 * File names never repeat the application name: the directory is already
 * named, so a file name only states its role.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface Paths {
	/** Root; overridable via `PI_REACTOR_DIR`, mirroring pi's PI_CODING_AGENT_DIR. */
	root: string;
	agentsFile: string;
	sinksFile: string;
	triggersFile: string;
	webhooksFile: string;
	/** 0600, credential values inlined. */
	credentialsFile: string;
	db: string;
	/** JSON-RPC control plane. */
	sock: string;
	/** O_EXCL singleton lock. */
	pidFile: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
	const root = env.PI_REACTOR_DIR?.trim() || join(homedir(), ".pi-reactor");
	return {
		root,
		agentsFile: join(root, "agents.json"),
		sinksFile: join(root, "sinks.json"),
		triggersFile: join(root, "triggers.json"),
		webhooksFile: join(root, "webhooks.json"),
		credentialsFile: join(root, "credentials.json"),
		db: join(root, "state.db"),
		sock: join(root, "daemon.sock"),
		pidFile: join(root, "daemon.pid"),
	};
}

/**
 * Creates the root idempotently at 0700 — credentials live in here.
 *
 * There is deliberately no logs/ directory: logs go to stdout for the
 * process manager to own (journald, tmux scrollback), so a directory here would
 * be a promise nothing keeps.
 */
export function ensureDirs(paths: Paths): void {
	mkdirSync(paths.root, { recursive: true, mode: 0o700 });
}

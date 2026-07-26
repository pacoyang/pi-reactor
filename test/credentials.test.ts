/**
 * The credential resolution chain, tier by tier.
 *
 * Order is the contract — systemd, credentials.json, environment, then pi's own
 * auth.json — because each tier exists for a deployment shape the next one
 * cannot serve, and a tier that silently never fires is worse than one that is
 * absent: `doctor` reports where a credential came from, and that report has to
 * be true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveProviderCredential,
	resolveSinkCredential,
	sinkEnvName,
	providerFromPiAuth,
} from "../src/core/credentials.ts";

function workspace(): { root: string; credentialsFile: string; cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "pi-reactor-cred-"));
	return {
		root,
		credentialsFile: join(root, "credentials.json"),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("provider: the systemd tier fires when the value is NOT already in the environment", async () => {
	// The regression this pins. The variable name came from a lookup that only
	// ever NAMES variables already set, so in the one situation this tier exists
	// for — the value living outside the environment — the name was undefined and
	// the whole tier was skipped. It could only ever have served a case tier 3
	// already handled, which is to say: never.
	const ws = workspace();
	try {
		const credsDir = join(ws.root, "creds");
		mkdirSync(credsDir);
		writeFileSync(join(credsDir, "provider_anthropic"), "sk-from-systemd\n");

		const resolved = await resolveProviderCredential("anthropic", {
			credentialsFile: ws.credentialsFile,
			env: { CREDENTIALS_DIRECTORY: credsDir },
			agentDir: join(ws.root, "no-pi-here"),
		});

		assert.equal(resolved?.source, "systemd");
		assert.deepEqual(resolved?.vars, { ANTHROPIC_API_KEY: "sk-from-systemd" },
			"the trailing newline systemd writes must be trimmed off");
	} finally {
		ws.cleanup();
	}
});

test("provider: credentials.json outranks the environment, and reports itself", async () => {
	const ws = workspace();
	try {
		writeFileSync(ws.credentialsFile, JSON.stringify({ "provider:anthropic": { ANTHROPIC_API_KEY: "sk-from-file" } }));

		const resolved = await resolveProviderCredential("anthropic", {
			credentialsFile: ws.credentialsFile,
			env: { ANTHROPIC_API_KEY: "sk-from-env" },
			agentDir: join(ws.root, "no-pi-here"),
		});

		assert.equal(resolved?.source, "credentials.json");
		assert.equal(resolved?.vars.ANTHROPIC_API_KEY, "sk-from-file");
	} finally {
		ws.cleanup();
	}
});

test("provider: the environment tier carries every variable pi would consult", async () => {
	const ws = workspace();
	try {
		const resolved = await resolveProviderCredential("anthropic", {
			credentialsFile: ws.credentialsFile,
			env: { ANTHROPIC_API_KEY: "sk-key", ANTHROPIC_OAUTH_TOKEN: "oauth-token" },
			agentDir: join(ws.root, "no-pi-here"),
		});

		assert.equal(resolved?.source, "env");
		// Both, deliberately: OAUTH silently outranks API_KEY inside pi, so passing
		// only one of them would change whose quota the job spends without saying so.
		assert.equal(resolved?.vars.ANTHROPIC_OAUTH_TOKEN, "oauth-token");
		assert.equal(resolved?.vars.ANTHROPIC_API_KEY, "sk-key");
	} finally {
		ws.cleanup();
	}
});

test("provider: falls back to the host's pi login, api_key entries only", async () => {
	const ws = workspace();
	try {
		const agentDir = join(ws.root, "pi-agent");
		mkdirSync(agentDir);
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				anthropic: { type: "api_key", key: "sk-from-pi-login" },
				openai: { type: "oauth", key: "expires-and-cannot-refresh-unattended" },
				sub2api: { type: "api_key", key: "sk-sub", env: { SUB2API_BASE_URL: "https://example.test" } },
			}),
		);
		const options = { credentialsFile: ws.credentialsFile, env: {}, agentDir };

		const anthropic = await resolveProviderCredential("anthropic", options);
		assert.equal(anthropic?.source, "pi-auth.json");
		assert.equal(anthropic?.vars.ANTHROPIC_API_KEY, "sk-from-pi-login");

		assert.equal(await resolveProviderCredential("openai", options), undefined,
			"an OAuth login expires and cannot be refreshed by an unattended daemon");

		// An extension-registered provider is unknown to pi's variable table, so the
		// naming convention has to carry it — and its extra env has to come along.
		const sub2api = await resolveProviderCredential("sub2api", options);
		assert.equal(sub2api?.vars.SUB2API_API_KEY, "sk-sub");
		assert.equal(sub2api?.vars.SUB2API_BASE_URL, "https://example.test");
	} finally {
		ws.cleanup();
	}
});

test("provider: nothing configured resolves to undefined, which preflight refuses on", async () => {
	const ws = workspace();
	try {
		const resolved = await resolveProviderCredential("anthropic", {
			credentialsFile: ws.credentialsFile,
			env: {},
			agentDir: join(ws.root, "no-pi-here"),
		});
		assert.equal(resolved, undefined,
			"refusing before spawn beats spawning and reading 'No API key found' out of the agent");
	} finally {
		ws.cleanup();
	}
});

test("sink: the same three tiers, in the same order", () => {
	const ws = workspace();
	try {
		const credsDir = join(ws.root, "creds");
		mkdirSync(credsDir);
		writeFileSync(ws.credentialsFile, JSON.stringify({ tg: { botToken: "from-file" } }));

		assert.equal(
			resolveSinkCredential("tg", "botToken", { credentialsFile: ws.credentialsFile, env: {} })?.source,
			"credentials.json",
		);
		assert.deepEqual(
			resolveSinkCredential("tg", "botToken", {
				credentialsFile: join(ws.root, "absent.json"),
				env: { REACTOR_TG_BOT_TOKEN: "from-env" },
			}),
			{ value: "from-env", source: "env" },
		);

		writeFileSync(join(credsDir, "tg_botToken"), "from-systemd");
		assert.equal(
			resolveSinkCredential("tg", "botToken", {
				credentialsFile: ws.credentialsFile,
				env: { CREDENTIALS_DIRECTORY: credsDir },
			})?.value,
			"from-systemd",
			"systemd's credentials directory is the most explicit source, so it wins",
		);
	} finally {
		ws.cleanup();
	}
});

test("sink env names are upper snake case under one prefix", () => {
	assert.equal(sinkEnvName("tg", "botToken"), "REACTOR_TG_BOT_TOKEN");
	assert.equal(sinkEnvName("team-alerts", "webhookUrl"), "REACTOR_TEAM_ALERTS_WEBHOOK_URL");
});

test("a missing or malformed auth.json is not an error, just an absent tier", () => {
	const ws = workspace();
	try {
		assert.equal(providerFromPiAuth("anthropic", "ANTHROPIC_API_KEY", { agentDir: ws.root }), undefined);
		writeFileSync(join(ws.root, "auth.json"), "{ not json");
		assert.equal(providerFromPiAuth("anthropic", "ANTHROPIC_API_KEY", { agentDir: ws.root }), undefined,
			"someone else's broken file must not stop our daemon starting");
	} finally {
		ws.cleanup();
	}
});

#!/usr/bin/env node
/**
 * A stand-in for `pi --mode rpc`, speaking just enough of the protocol for the
 * worker tests: get_state, prompt, abort, and the agent_settled completion
 * signal. The contract test pins the real thing; this exists so queue behaviour
 * (serialisation, the timeout chain) can be tested in milliseconds and without
 * spending tokens.
 *
 * Behaviour is driven by env vars:
 *   STUB_WORK_MS   how long the "run" takes before settling (default 50)
 *   STUB_HANG      never settle, so the caller's timeout chain has to fire
 *   STUB_TEXT      the assistant text to report
 *   STUB_TOKENS    total tokens to report
 *   STUB_LEAK_MS   leave a detached child holding stdout for this long, the way a
 *                  real agent's `npm run dev &` does. `close` will not fire until
 *                  that child exits, which is the whole point of the test.
 */
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";

const workMs = Number(process.env.STUB_WORK_MS ?? 50);
const hang = process.env.STUB_HANG === "1";
const text = process.env.STUB_TEXT ?? "stub done";
const tokens = Number(process.env.STUB_TOKENS ?? 100);
const leakMs = Number(process.env.STUB_LEAK_MS ?? 0);

if (leakMs > 0) {
	spawn(process.execPath, ["-e", `setTimeout(() => {}, ${leakMs})`], {
		stdio: ["ignore", "inherit", "inherit"],
		detached: true,
	}).unref();
}

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let aborted = false;
let timer;

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	let i;
	while ((i = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, i);
		buffer = buffer.slice(i + 1);
		if (!line.trim()) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			send({ type: "response", command: "parse", success: false, error: "bad json" });
			continue;
		}
		handle(msg);
	}
});

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(143));

function handle(msg) {
	switch (msg.type) {
		case "get_state":
			send({
				id: msg.id, type: "response", command: "get_state", success: true,
				data: { sessionId: "stub-session", isStreaming: false, sessionFile: "/tmp/stub-session.jsonl" },
			});
			return;

		case "prompt":
			send({ id: msg.id, type: "response", command: "prompt", success: true });
			send({ type: "agent_start" });
			if (hang) return; // caller must drive the termination chain
			timer = setTimeout(() => {
				if (aborted) return;
				send({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text }],
						stopReason: "stop",
						usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
					},
				});
				send({ type: "agent_end" });
				send({ type: "agent_settled" });
			}, workMs);
			return;

		case "abort":
			aborted = true;
			if (timer) clearTimeout(timer);
			send({ id: msg.id, type: "response", command: "abort", success: true });
			return;

		case "get_last_assistant_text":
			send({ id: msg.id, type: "response", command: "get_last_assistant_text", success: true, data: { text } });
			return;

		default:
			send({ id: msg.id, type: "response", command: msg.type, success: false, error: "unsupported" });
	}
}

// Stay alive on stdin like the real thing.
setInterval(() => {}, 1 << 30).unref();
process.stdin.resume();

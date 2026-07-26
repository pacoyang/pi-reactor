/**
 * Client half of the control plane.
 *
 * One request, one response, then close. Shared by the CLI and the operator
 * extension so the two cannot drift — the extension is deliberately a thin client
 * with no business logic of its own, and this is the whole of what it
 * needs to be one.
 *
 * There is deliberately no client-side queue or retry: when the daemon is absent
 * the caller gets a plain error to act on, because a silently buffered event is
 * worse than a visible failure.
 */
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { JSONRPC_VERSION, type RpcResponse } from "./rpc-types.ts";

export class DaemonUnavailableError extends Error {
	override readonly name = "DaemonUnavailableError";
}

export class DaemonCallError extends Error {
	override readonly name = "DaemonCallError";
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

export interface CallOptions {
	socketPath: string;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function callDaemon(
	options: CallOptions,
	method: string,
	params: Record<string, unknown> = {},
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = connect(options.socketPath);
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let done = false;

		const finish = (err?: Error, result?: unknown): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			if (err) reject(err);
			else resolve(result);
		};

		const timer = setTimeout(
			() => finish(new DaemonUnavailableError(`no reply from the daemon within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)),
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
		timer.unref();

		socket.on("error", (err: NodeJS.ErrnoException) => {
			// ENOENT: no socket file. ECONNREFUSED: a stale one nobody is listening
			// on. Both mean the same thing to a caller, and neither is a bug here.
			finish(
				err.code === "ENOENT" || err.code === "ECONNREFUSED"
					? new DaemonUnavailableError(`daemon not running (no socket at ${options.socketPath})`)
					: err,
			);
		});

		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: 1, method, params })}\n`);
		});

		socket.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			const index = buffer.indexOf("\n");
			if (index === -1) return;
			try {
				const response = JSON.parse(buffer.slice(0, index)) as RpcResponse;
				if ("error" in response) finish(new DaemonCallError(response.error.code, response.error.message));
				else finish(undefined, response.result);
			} catch (err) {
				finish(err as Error);
			}
		});

		socket.on("close", () => finish(new DaemonUnavailableError("the daemon closed the connection without replying")));
	});
}

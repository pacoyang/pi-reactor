/**
 * JSON-RPC 2.0 server over a unix socket.
 *
 * Frames are newline-delimited, split on LF only — the same discipline the pi
 * RPC transport enforces, and for the same reason: U+2028/U+2029 are legal
 * inside JSON strings, so anything that splits on "line separators" in the
 * Unicode sense will cut a frame in half.
 *
 * The socket file mode is the authentication: 0600 means only this user's
 * processes can connect. The public entrance is never this socket.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
	JSONRPC_VERSION,
	RPC_ERRORS,
	RpcError,
	rpcFailure,
	rpcSuccess,
	type RpcRequest,
} from "../core/rpc-types.ts";
import type { Logger } from "./logger.ts";
import { errorSummary } from "./logger.ts";

/** Guards against a runaway writer filling memory one unterminated line at a time. */
const MAX_LINE_BYTES = 1024 * 1024;

export type MethodHandler = (params: Record<string, unknown>, context: CallContext) => Promise<unknown> | unknown;

export interface CallContext {
	method: string;
}

export interface RpcServerOptions {
	socketPath: string;
	methods: Record<string, MethodHandler>;
	logger: Logger;
}

export interface RpcServer {
	server: Server;
	close(): Promise<void>;
}

export async function startRpcServer(options: RpcServerOptions): Promise<RpcServer> {
	const { socketPath, methods, logger } = options;

	// A leftover socket file from a hard kill would make listen() fail with
	// EADDRINUSE. Safe to remove here because the singleton lock has
	// already established that no live daemon owns this directory.
	if (existsSync(socketPath)) unlinkSync(socketPath);

	const sockets = new Set<Socket>();

	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", (err) => logger.debug("rpc_socket_error", { error: errorSummary(err) }));

		const decoder = new StringDecoder("utf8");
		let buffer = "";

		socket.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			if (buffer.length > MAX_LINE_BYTES) {
				logger.warn("rpc_line_too_long", { bytes: buffer.length });
				socket.destroy();
				return;
			}
			let index: number;
			while ((index = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				if (line.trim() === "") continue;
				void handleLine(line, socket);
			}
		});
	});

	async function handleLine(line: string, socket: Socket): Promise<void> {
		let request: RpcRequest;
		try {
			request = JSON.parse(line) as RpcRequest;
		} catch {
			write(socket, rpcFailure(null, RPC_ERRORS.PARSE_ERROR, "invalid JSON"));
			return;
		}

		if (request.jsonrpc !== JSONRPC_VERSION || typeof request.method !== "string") {
			write(socket, rpcFailure(request.id ?? null, RPC_ERRORS.INVALID_REQUEST, "not a JSON-RPC 2.0 request"));
			return;
		}

		const handler = methods[request.method];
		// A notification (no id) still runs, it just gets no reply.
		const id = request.id;

		if (!handler) {
			if (id !== undefined) {
				write(socket, rpcFailure(id, RPC_ERRORS.METHOD_NOT_FOUND, `unknown method ${request.method}`));
			}
			return;
		}

		const context: CallContext = { method: request.method };
		try {
			const result = await handler(request.params ?? {}, context);
			if (id !== undefined) write(socket, rpcSuccess(id, result ?? null));
		} catch (err) {
			const code = err instanceof RpcError ? err.code : RPC_ERRORS.INTERNAL_ERROR;
			const message = err instanceof Error ? err.message : String(err);
			// Log at warn for expected refusals, error for genuine surprises.
			const log = err instanceof RpcError ? logger.warn : logger.error;
			log.call(logger, "rpc_method_failed", { method: request.method, code, error: errorSummary(err) });
			if (id !== undefined) {
				write(socket, rpcFailure(id, code, message, err instanceof RpcError ? err.data : undefined));
			}
		}
	}

	function write(socket: Socket, payload: unknown): void {
		if (socket.writable) socket.write(`${JSON.stringify(payload)}\n`);
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	// The mode argument to listen() is not portable; set it explicitly.
	chmodSync(socketPath, 0o600);
	logger.info("rpc_listening", { socket: socketPath });

	return {
		server,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (existsSync(socketPath)) {
				try {
					unlinkSync(socketPath);
				} catch {
					// Best effort during shutdown.
				}
			}
		},
	};
}

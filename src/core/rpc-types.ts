/**
 * Control-plane protocol types.
 *
 * Newline-delimited JSON-RPC 2.0 over a unix socket — the same shape MCP uses
 * for its stdio transport, and LSP before it. Request/notification split, error
 * codes and id correlation all come from the spec rather than being reinvented.
 *
 * Named `rpc-types.ts` after pi's own `modes/rpc/rpc-types.ts`, forming a trio
 * with rpc-server.ts and rpc-methods.ts.
 */

export const JSONRPC_VERSION = "2.0" as const;

export interface RpcRequest {
	jsonrpc: typeof JSONRPC_VERSION;
	/** Absent means notification: no reply is sent. */
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface RpcSuccess {
	jsonrpc: typeof JSONRPC_VERSION;
	id: string | number;
	result: unknown;
}

export interface RpcFailure {
	jsonrpc: typeof JSONRPC_VERSION;
	id: string | number | null;
	error: { code: number; message: string; data?: unknown };
}

export type RpcResponse = RpcSuccess | RpcFailure;

/** Spec-reserved codes plus our application range, which starts at -32000. */
export const RPC_ERRORS = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	/** Application: the daemon is shutting down and no longer accepts work. */
	SHUTTING_DOWN: -32000,
	/** Application: the caller's token does not grant this method. */
	FORBIDDEN: -32001,
} as const;

export class RpcError extends Error {
	override readonly name = "RpcError";
	readonly code: number;
	readonly data: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

export function rpcSuccess(id: string | number, result: unknown): RpcSuccess {
	return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcFailure(id: string | number | null, code: number, message: string, data?: unknown): RpcFailure {
	return {
		jsonrpc: JSONRPC_VERSION,
		id,
		error: { code, message, ...(data === undefined ? {} : { data }) },
	};
}

// ---------------------------------------------------------------- method payloads

/** `emit` carries a CloudEvents envelope plus our routing extensions. */
export interface EmitParams {
	ce: {
		specversion: string;
		id: string;
		source: string;
		type: string;
		time?: string;
		data?: Record<string, unknown>;
	};
	lane: "interactive" | "batch";
	route: {
		agent: string;
		task?: string;
		skill?: string;
		maxDuration?: string | number;
		requireCleanTree?: boolean;
		retryable?: boolean;
		triggerId?: string;
	};
	notify?: { sink: string; when?: "success" | "failure" | "always" };
}

export interface EmitResult {
	seq: number;
	jobId: number | null;
	/** True when (source,id) already existed. An idempotent success: do not retry. */
	duplicate: boolean;
}

export interface StatusResult {
	pid: number;
	startedAt: string;
	paused: boolean;
	queue: { pending: number; running: number };
	/** Undelivered and dead-lettered notifications; `dead` is the one that needs a human. */
	outbox: { pending: number; dead: number };
	today: { runs: number; totalTokens: number; cap: number | null };
	agents: string[];
}

export interface RunSummary {
	id: number;
	jobId: number | null;
	agent: string;
	outcome: string | null;
	reason: string | null;
	totalTokens: number | null;
	startedAt: string;
	finishedAt: string | null;
	errorSummary: string | null;
}

export interface NotifyParams {
	sink: string;
	body: string;
}

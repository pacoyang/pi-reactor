/**
 * The public webhook process.
 *
 * A separate process from the daemon on purpose: this is the only thing that
 * binds a public port, and it holds no database, no queue and no credentials
 * beyond the shared secrets it needs to verify signatures. The daemon never
 * listens on the network — it is reachable only through its 0600 unix socket,
 * which this process is a client of like any other.
 *
 * One pipeline, whatever the provider:
 *
 *   read (<= 2 MiB)  ->  verify  ->  gates  ->  CloudEvent  ->  daemon.sock
 *
 * and the response codes carry the meaning:
 *   401  the signature did not check out
 *   204  authentic, but nothing here wants it
 *   202  enqueued, or a redelivery we already have
 *   503  the daemon is not reachable, so retry it
 *   200  a handshake the provider expects a bare OK for
 *
 * 202-for-redelivery matters: GitHub does NOT retry failed deliveries
 * automatically, so anything we answer with a 5xx is simply lost unless someone
 * replays it by hand. Saying "accepted" to a duplicate is honest — the work is
 * already queued — and it keeps the delivery log clean enough to spot the ones
 * that genuinely failed.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Paths } from "../core/paths.ts";
import { loadWebhooks, type WebhookEndpointSpec, type TriggerSpec, type GithubTriggerSpec } from "../core/config.ts";
import { readCredentialsFile, resolveSinkCredential } from "../core/credentials.ts";
import { callDaemon, DaemonUnavailableError } from "../core/rpc-client.ts";
import { CE_SPEC_VERSION } from "../core/cloudevents.ts";
import { createLogger, errorSummary, type Logger } from "../daemon/logger.ts";
import { getProvider, providerNames, type MatchFacts } from "./provider.ts";
import "./provider-github.ts";

/** A body larger than this is refused unread: we sign-verify whole bodies. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface WebhookServeOptions {
	paths: Paths;
	port?: number;
	host?: string;
	logger?: Logger;
	/** Injected by tests; production talks to the daemon over its socket. */
	callDaemonImpl?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface RunningWebhook {
	server: Server;
	port: number;
	stop(): Promise<void>;
}

const DEFAULT_PORT = 8787;

export async function serveWebhooks(options: WebhookServeOptions): Promise<RunningWebhook> {
	const logger = options.logger ?? createLogger();
	const endpoints = loadWebhooks(options.paths);
	if (Object.keys(endpoints).length === 0) {
		throw new Error(`no endpoints in ${options.paths.webhooksFile}; nothing to serve`);
	}

	// Secrets are read once, at startup, and held in memory. Re-reading per
	// request would put a file read on the hot path of an unauthenticated
	// endpoint, which is the wrong direction.
	const secrets = new Map<string, string>();
	const credentials = readCredentialsFile(options.paths.credentialsFile);
	for (const endpoint of Object.values(endpoints)) {
		if (!getProvider(endpoint.provider)) {
			throw new Error(`endpoint "${endpoint.name}": unknown provider "${endpoint.provider}" (have: ${providerNames().join(", ")})`);
		}
		const secret = resolveSinkCredential(endpoint.credential, "webhookSecret", {
			credentialsFile: options.paths.credentialsFile,
			preloaded: credentials,
		});
		if (!secret) {
			throw new Error(
				`endpoint "${endpoint.name}": no webhookSecret for "${endpoint.credential}". ` +
					`Add it with: pi-reactor secret set ${endpoint.credential} webhookSecret`,
			);
		}
		secrets.set(endpoint.name, secret.value);
	}

	const byPath = new Map<string, WebhookEndpointSpec>();
	for (const endpoint of Object.values(endpoints)) byPath.set(endpoint.path, endpoint);

	const call =
		options.callDaemonImpl ??
		((method: string, params: Record<string, unknown>) => callDaemon({ socketPath: options.paths.sock }, method, params));

	const server = createServer((req, res) => {
		void handleRequest(req, res, { byPath, secrets, call, logger });
	});

	const port = options.port ?? DEFAULT_PORT;
	const host = options.host ?? "127.0.0.1";
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	logger.info("webhook_listening", {
		host,
		port: actualPort,
		endpoints: Object.values(endpoints).map((e) => `${e.path} -> ${e.provider}`),
	});

	return {
		server,
		port: actualPort,
		stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

interface HandlerDeps {
	byPath: Map<string, WebhookEndpointSpec>;
	secrets: Map<string, string>;
	call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
	logger: Logger;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps): Promise<void> {
	const url = req.url?.split("?")[0] ?? "/";

	// A liveness path that reveals nothing: useful behind a tunnel, and it must
	// not be confusable with an endpoint.
	if (req.method === "GET" && url === "/healthz") return send(res, 200, "ok");
	if (req.method !== "POST") return send(res, 405, "method not allowed");

	const endpoint = deps.byPath.get(url);
	// 404 rather than a hint: an unauthenticated caller learns nothing about which
	// paths exist.
	if (!endpoint) return send(res, 404, "not found");

	let rawBody: Buffer;
	try {
		rawBody = await readBody(req);
	} catch (err) {
		const tooBig = err instanceof BodyTooLarge;
		deps.logger.warn("webhook_body_rejected", { path: url, error: errorSummary(err) });
		return send(res, tooBig ? 413 : 400, tooBig ? "body too large" : "bad request");
	}

	const provider = getProvider(endpoint.provider);
	if (!provider) return send(res, 500, "provider missing");

	const verdict = provider.handle({
		endpoint,
		headers: req.headers,
		rawBody,
		secret: deps.secrets.get(endpoint.name) ?? "",
	});

	if (verdict.kind === "reject") {
		// Deliberately terse to the sender, detailed in the log: telling an
		// unauthenticated caller which check failed helps only them.
		deps.logger.warn("webhook_rejected", { endpoint: endpoint.name, reason: verdict.reason });
		return send(res, 401, "unauthorized");
	}
	if (verdict.kind === "ack") {
		deps.logger.info("webhook_ack", { endpoint: endpoint.name, reason: verdict.reason });
		return send(res, 200, "ok");
	}
	if (verdict.kind === "ignore") {
		deps.logger.info("webhook_ignored", { endpoint: endpoint.name, reason: verdict.reason });
		return send(res, 204, "");
	}

	const event = verdict.event;

	// Triggers come from the daemon rather than from a second reading of
	// triggers.json. The daemon owns that file and hot-reloads it; a second
	// reader here would need its own reload protocol and could disagree with the
	// thing that actually runs the work.
	let triggers: TriggerSpec[];
	try {
		const listed = (await deps.call("trigger.ls", {})) as { triggers: TriggerSpec[] };
		triggers = listed.triggers;
	} catch (err) {
		deps.logger.error("webhook_daemon_unreachable", { endpoint: endpoint.name, error: errorSummary(err) });
		// 503 asks the sender to try again. GitHub will not, but a tunnel or a
		// replay by hand can, and a 2xx here would claim we had accepted work we
		// dropped on the floor.
		return send(res, 503, "daemon unavailable");
	}

	const matched = triggers.filter((t): t is GithubTriggerSpec => t.kind === "github" && matches(t, event.match));
	if (matched.length === 0) {
		deps.logger.info("webhook_unmatched", {
			endpoint: endpoint.name,
			type: event.type,
			labels: event.match.labels,
		});
		return send(res, 204, "");
	}

	const results: Array<{ trigger: string; jobId: number | null; duplicate: boolean }> = [];
	for (const trigger of matched) {
		try {
			const result = (await deps.call("emit", {
				// The delivery GUID stays the id, and the trigger id
				// rides in the source. Two triggers matching one delivery is a fan-out,
				// not a duplicate — but a REDELIVERY of that guid still collides per
				// trigger, which is the property the whole dedup rests on.
				ce: {
					specversion: CE_SPEC_VERSION,
					id: event.id,
					source: `github:${endpoint.name}:${trigger.id}`,
					type: event.type,
					time: new Date().toISOString(),
					data: event.data,
				},
				lane: "batch",
				route: {
					agent: trigger.run.agent,
					...(trigger.run.task ? { task: trigger.run.task } : {}),
					...(trigger.run.skill ? { skill: trigger.run.skill } : {}),
					triggerId: trigger.id,
					maxDuration: trigger.run.maxDurationS,
					requireCleanTree: trigger.run.requireCleanTree,
					retryable: trigger.run.retryable,
				},
				...(trigger.notify ? { notify: trigger.notify } : {}),
			})) as { jobId: number | null; duplicate: boolean };
			results.push({ trigger: trigger.id, jobId: result.jobId, duplicate: result.duplicate });
		} catch (err) {
			deps.logger.error("webhook_emit_failed", { endpoint: endpoint.name, trigger: trigger.id, error: errorSummary(err) });
			if (err instanceof DaemonUnavailableError) return send(res, 503, "daemon unavailable");
			// The daemon refused this one trigger — a deleted agent, most likely.
			// Other matches may still be good, so carry on and report at the end.
			results.push({ trigger: trigger.id, jobId: null, duplicate: false });
		}
	}

	deps.logger.info("webhook_accepted", { endpoint: endpoint.name, type: event.type, delivery: event.id, results });
	return send(res, 202, JSON.stringify({ accepted: results }));
}

/**
 * Does this trigger want this delivery?
 *
 * `event` must match; `action` and `any` narrow it when present. `any` is an
 * OR over labels — "run when someone puts pi:fix on it" — which is the shape
 * pi-dispatch's label gate uses and the one people expect from a label.
 */
export function matches(trigger: GithubTriggerSpec, facts: MatchFacts): boolean {
	if (trigger.event !== facts.event) return false;
	if (trigger.action && trigger.action.length > 0) {
		if (facts.action === undefined || !trigger.action.includes(facts.action)) return false;
	}
	if (trigger.any && trigger.any.length > 0) {
		if (!trigger.any.some((label) => facts.labels.includes(label))) return false;
	}
	return true;
}

class BodyTooLarge extends Error {
	override readonly name = "BodyTooLarge";
}

/** Reads at most MAX_BODY_BYTES, aborting the moment the limit is passed. */
export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				// Stop reading rather than buffer to the end and then complain: this
				// endpoint is unauthenticated, so the memory is anyone's to spend.
				req.destroy();
				reject(new BodyTooLarge(`body exceeds ${limit} bytes`));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function send(res: ServerResponse, status: number, body: string): void {
	if (body === "") {
		res.writeHead(status);
		res.end();
		return;
	}
	const isJson = body.startsWith("{");
	res.writeHead(status, { "content-type": isJson ? "application/json" : "text/plain; charset=utf-8" });
	res.end(body);
}

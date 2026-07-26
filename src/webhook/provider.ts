/**
 * Provider profiles: the three functions a webhook source has to supply.
 *
 * The whole reason this is a profile rather than a process per provider is that
 * the industry only has four signature families — raw HMAC over the body
 * (GitHub, Gitea), Standard Webhooks (OpenAI, Anthropic, Supabase, PagerDuty),
 * timestamped proprietary HMAC (Stripe, Slack), and a static token comparison
 * (GitLab). One pipeline plus thirty lines per family beats a process each.
 *
 * Only the first family is implemented. The others slot in here without touching serve.ts.
 */
import type { WebhookEndpointSpec } from "../core/config.ts";

/** What the pipeline decided, and what the sender is told. */
export type Verdict =
	| { kind: "accept"; event: ProviderEvent }
	/** Well-formed and authentic, but nothing here wants it. 204. */
	| { kind: "ignore"; reason: string }
	/** A handshake or health probe the provider expects a bare 200 for. */
	| { kind: "ack"; reason: string }
	/** Signature failed, or the request is not what it claims to be. 401. */
	| { kind: "reject"; reason: string };

export interface ProviderEvent {
	/** CloudEvents id — the provider's own delivery identifier, never one we invent. */
	id: string;
	/** CloudEvents type, reverse-DNS. */
	type: string;
	/** The projection triggers match against and the agent receives. */
	data: Record<string, unknown>;
	/** Fields the trigger matcher understands, extracted once here. */
	match: MatchFacts;
}

/**
 * The provider-independent facts a trigger can match on.
 *
 * Deliberately small. A trigger says "issues, labeled, carrying pi:fix"; letting
 * it reach into arbitrary payload paths would turn triggers.json into a query
 * language, and every provider would need its own dialect.
 */
export interface MatchFacts {
	/** e.g. "issues", "pull_request". */
	event: string;
	/** e.g. "labeled". Absent for events that have no action. */
	action?: string | undefined;
	/** Labels, tags — whatever the provider calls the thing `any` selects on. */
	labels: string[];
}

export interface VerifyInput {
	endpoint: WebhookEndpointSpec;
	headers: Record<string, string | string[] | undefined>;
	/** The bytes as received. Parsing before verifying would be the bug. */
	rawBody: Buffer;
	secret: string;
}

export interface Provider {
	name: string;
	/**
	 * Verifies and projects in one step.
	 *
	 * One function rather than verify/extractId/extractType separately, because
	 * every extraction depends on the request having been verified first, and a
	 * three-function shape lets a caller skip the first one. Here the only way to
	 * get an id is to have passed the signature check.
	 */
	handle(input: VerifyInput): Verdict;
}

const REGISTRY = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
	REGISTRY.set(provider.name, provider);
}

export function getProvider(name: string): Provider | undefined {
	return REGISTRY.get(name);
}

export function providerNames(): string[] {
	return [...REGISTRY.keys()].sort();
}

/** Case-insensitive single header value; Node lowercases incoming names, senders do not. */
export function header(headers: VerifyInput["headers"], name: string): string | undefined {
	const value = headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : value;
}

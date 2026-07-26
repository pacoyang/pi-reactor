/**
 * GitHub provider profile: raw HMAC-SHA256 over the body.
 *
 * The same family as Gitea. Three things this file is
 * responsible for and nothing else: proving the request came from GitHub,
 * deciding whether it is ours to act on, and projecting the payload down to
 * something a trigger can match and an agent can read.
 *
 * Gate order is load-bearing:
 *   1. bot loop   — your own bot is usually also a collaborator, so if this ran
 *                   after the authorization gate a bot would authorise itself and
 *                   a comment-reply loop could run until the budget cap stopped it
 *   2. authorization — GitHub states `author_association` on the payload, so this
 *                   costs no API call and cannot be spoofed past the signature
 *   3. trigger matching happens outside, in serve.ts, since it is not GitHub's
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { registerProvider, header, type Provider, type Verdict, type MatchFacts } from "./provider.ts";

/** A payload big enough to matter is a payload we do not project in full. */
const MAX_TEXT = 4000;

interface GithubPayload {
	action?: string;
	sender?: { id?: number; login?: string; type?: string };
	repository?: { full_name?: string; default_branch?: string; html_url?: string };
	issue?: GithubIssue;
	pull_request?: GithubIssue;
	comment?: { body?: string; html_url?: string; user?: { login?: string }; author_association?: string };
	label?: { name?: string };
	installation?: { id?: number };
}

interface GithubIssue {
	number?: number;
	title?: string;
	body?: string;
	html_url?: string;
	state?: string;
	draft?: boolean;
	labels?: Array<{ name?: string } | string>;
	author_association?: string;
	user?: { login?: string };
	head?: { ref?: string; sha?: string };
	base?: { ref?: string };
}

/**
 * Constant-time comparison of the hex digest.
 *
 * `timingSafeEqual` throws when the lengths differ, so the length check has to
 * come first — and it is not a leak: the digest length is fixed and public.
 */
export function verifySignature(rawBody: Buffer, secret: string, signatureHeader: string | undefined): boolean {
	if (!signatureHeader?.startsWith("sha256=")) return false;
	const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
	const expected = createHmac("sha256", secret).update(rawBody).digest();
	if (provided.length !== expected.length) return false;
	return timingSafeEqual(provided, expected);
}

function labelsOf(issue: GithubIssue | undefined): string[] {
	if (!Array.isArray(issue?.labels)) return [];
	return issue.labels
		.map((l) => (typeof l === "string" ? l : l?.name))
		.filter((l): l is string => typeof l === "string" && l !== "");
}

function truncate(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}\n…[truncated]`;
}

/**
 * A slim projection, not the whole payload.
 *
 * A GitHub webhook body runs to tens of kilobytes of repository metadata. All of
 * it would land in the events table, and the parts an agent actually reads are
 * these. Anything missing is one `gh` call away inside the job, where it is
 * fetched fresh rather than replayed from whenever the delivery happened.
 */
export function projectPayload(event: string, payload: GithubPayload): Record<string, unknown> {
	const subject = payload.issue ?? payload.pull_request;
	return {
		event,
		...(payload.action ? { action: payload.action } : {}),
		...(payload.repository?.full_name ? { repo: payload.repository.full_name } : {}),
		...(payload.sender?.login ? { sender: payload.sender.login } : {}),
		...(subject
			? {
					subject: {
						kind: payload.pull_request ? "pull_request" : "issue",
						number: subject.number,
						title: subject.title,
						url: subject.html_url,
						state: subject.state,
						...(subject.draft !== undefined ? { draft: subject.draft } : {}),
						labels: labelsOf(subject),
						author: subject.user?.login,
						...(subject.head?.ref ? { headRef: subject.head.ref } : {}),
						...(subject.base?.ref ? { baseRef: subject.base.ref } : {}),
						body: truncate(subject.body),
					},
				}
			: {}),
		...(payload.comment
			? { comment: { author: payload.comment.user?.login, url: payload.comment.html_url, body: truncate(payload.comment.body) } }
			: {}),
		...(payload.label?.name ? { label: payload.label.name } : {}),
	};
}

function facts(event: string, payload: GithubPayload): MatchFacts {
	const subject = payload.issue ?? payload.pull_request;
	// A `labeled` delivery names the label that was just added; that is what a
	// trigger means by "when someone puts pi:fix on it", and it is not always in
	// the subject's label list yet.
	const labels = new Set(labelsOf(subject));
	if (payload.label?.name) labels.add(payload.label.name);
	return {
		event,
		...(payload.action ? { action: payload.action } : {}),
		labels: [...labels],
	};
}

/** Whoever GitHub says is responsible for the thing that fired the event. */
function association(payload: GithubPayload): string | undefined {
	return payload.comment?.author_association ?? (payload.issue ?? payload.pull_request)?.author_association;
}

export const githubProvider: Provider = {
	name: "github",

	handle({ endpoint, headers, rawBody, secret }): Verdict {
		const event = header(headers, "x-github-event");
		const delivery = header(headers, "x-github-delivery");

		// Verify before parsing, always: the body is attacker-controlled until the
		// signature says otherwise, and a parser is a much larger surface than an
		// HMAC comparison.
		if (!verifySignature(rawBody, secret, header(headers, "x-hub-signature-256"))) {
			return { kind: "reject", reason: "bad or missing X-Hub-Signature-256" };
		}
		if (!event) return { kind: "reject", reason: "missing X-GitHub-Event" };
		if (!delivery) return { kind: "reject", reason: "missing X-GitHub-Delivery" };

		// GitHub sends `ping` when a hook is created and wants a bare 200. It is
		// signed like anything else, so this check belongs after verification.
		if (event === "ping") return { kind: "ack", reason: "ping" };

		let payload: GithubPayload;
		try {
			payload = JSON.parse(rawBody.toString("utf8")) as GithubPayload;
		} catch {
			return { kind: "reject", reason: "signature verified but the body is not JSON" };
		}

		// Gate 1: bot loop. Before authorization, not after — see the header.
		const senderId = payload.sender?.id === undefined ? undefined : String(payload.sender.id);
		const senderLogin = payload.sender?.login;
		if (payload.sender?.type === "Bot") {
			return { kind: "ignore", reason: `sender ${senderLogin ?? "?"} is a bot` };
		}
		for (const ignored of endpoint.ignoreSenders) {
			if (ignored === senderId || ignored === senderLogin) {
				return { kind: "ignore", reason: `sender ${ignored} is on this endpoint's ignore list` };
			}
		}

		// Gate 2: authorization, from the payload itself.
		const assoc = association(payload);
		if (endpoint.allowAssociations.length > 0 && (assoc === undefined || !endpoint.allowAssociations.includes(assoc))) {
			return { kind: "ignore", reason: `author_association ${assoc ?? "(none)"} is not allowed to trigger work` };
		}

		return {
			kind: "accept",
			event: {
				id: delivery,
				type: `com.github.${event}${payload.action ? `.${payload.action}` : ""}`,
				data: projectPayload(event, payload),
				match: facts(event, payload),
			},
		};
	},
};

registerProvider(githubProvider);

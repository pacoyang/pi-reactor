/**
 * Slack sink via an Incoming Webhook.
 *
 * The same SendResult contract as the Telegram sink, so the relay treats both
 * identically — throttling is not failure, a formatting rejection must not lose
 * the message, and an oversized body is split rather than truncated.
 *
 * What differs is the dialect. Slack's mrkdwn is not Markdown: bold is `*one
 * star*`, links are `<url|label>`, and exactly three characters have to be
 * escaped (`&`, `<`, `>`) — in that order, or you double-escape the ampersands
 * you just introduced. Agent output is Markdown, so it is translated here rather
 * than sent raw, where `**bold**` would arrive as literal asterisks.
 */
import type { SinkSpec } from "../core/config.ts";
import type { SendResult } from "./sink-telegram.ts";

/**
 * Slack accepts 40,000 characters in `text`, but renders anything past roughly
 * 3,000 as a "show more" stub. Splitting at a readable size beats delivering one
 * message the reader has to expand.
 */
export const SLACK_MAX_TEXT = 3500;

export interface SlackSendOptions {
	sink: SinkSpec;
	webhookUrl: string;
	body: string;
	fetchImpl?: typeof fetch;
}

export async function sendSlack(options: SlackSendOptions): Promise<SendResult> {
	const doFetch = options.fetchImpl ?? fetch;

	for (const chunk of splitForSlack(options.body)) {
		let response: Response;
		try {
			response = await doFetch(options.webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: renderSlackMrkdwn(chunk), mrkdwn: true }),
			});
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}

		if (response.status === 429) {
			// One message per second per webhook is Slack's documented rate; the
			// header says how long to wait and it is not a failure.
			const retryAfter = Number(response.headers.get("retry-after") ?? 30);
			return {
				ok: false,
				throttled: true,
				retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30,
				error: `rate limited, retry after ${retryAfter}s`,
			};
		}

		if (!response.ok) {
			// Incoming webhooks answer with a bare reason string, not JSON.
			const detail = await response.text().catch(() => "");
			return { ok: false, error: detail.trim() || `HTTP ${response.status}` };
		}
	}

	return { ok: true };
}

/** Same boundary preference as Telegram: paragraph, then line, then a hard cut. */
export function splitForSlack(body: string, limit = SLACK_MAX_TEXT): string[] {
	const rendered = (s: string): number => renderSlackMrkdwn(s).length;
	if (rendered(body) <= limit) return [body];

	const chunks: string[] = [];
	let rest = body;
	while (rest !== "") {
		if (rendered(rest) <= limit) {
			chunks.push(rest);
			break;
		}
		let take = Math.min(rest.length, limit);
		while (take > 1 && rendered(rest.slice(0, take)) > limit) take = Math.floor(take * 0.9);

		const window = rest.slice(0, take);
		let cut = window.lastIndexOf("\n\n");
		if (cut < take * 0.5) cut = window.lastIndexOf("\n");
		if (cut < take * 0.5) cut = take;
		const chunk = rest.slice(0, cut).trimEnd();
		if (chunk !== "") chunks.push(chunk);
		rest = rest.slice(cut).trimStart();
	}
	return chunks.length > 0 ? chunks : [body];
}

/**
 * Markdown to Slack mrkdwn.
 *
 * Code spans are lifted out first, behind NUL-delimited placeholders, so the
 * translation below cannot reach into them. NUL specifically, written as an
 * explicit `\u0000` escape: the delimiter has to be something agent output can
 * never contain, and a raw control byte in source is invisible in every diff.
 * Same reasoning as the Telegram renderer — do not "tidy" these away.
 */
export function renderSlackMrkdwn(markdown: string): string {
	const blocks: string[] = [];
	let text = markdown.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_all, code: string) => {
		blocks.push(`\`\`\`\n${escapeSlack(code.replace(/\n$/, ""))}\n\`\`\``);
		return `\u0000BLOCK${blocks.length - 1}\u0000`;
	});

	const spans: string[] = [];
	text = text.replace(/`([^`\n]+)`/g, (_all, code: string) => {
		spans.push(`\`${escapeSlack(code)}\``);
		return `\u0000SPAN${spans.length - 1}\u0000`;
	});

	text = escapeSlack(text);

	// Links before emphasis, since a label may contain emphasis markers.
	text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_all, label: string, href: string) => `<${href}|${label}>`);

	// Bold first: `**x**` must not be seen as two single-star italics.
	text = text.replace(/\*\*([^*\n]+)\*\*/g, "\u0000B\u0000$1\u0000B\u0000");
	text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1_$2_");
	text = text.replace(/\u0000B\u0000/g, "*");

	// Headings have no mrkdwn equivalent; bold reads closest.
	text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

	text = text.replace(/\u0000SPAN(\d+)\u0000/g, (_all, i: string) => spans[Number(i)] as string);
	text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (_all, i: string) => blocks[Number(i)] as string);
	return text;
}

/** Exactly the three characters Slack requires, ampersand first to avoid double-escaping. */
export function escapeSlack(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

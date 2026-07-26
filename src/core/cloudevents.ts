/**
 * CloudEvents 1.0 envelope construction and validation.
 *
 * The spec requires exactly four attributes — specversion, id, source, type —
 * and states that producers MUST ensure `source` + `id` is unique per distinct
 * event. That rule IS our deduplication semantics: the unique index on
 * (ce_source, ce_id) turns cron misfire catch-up and webhook redelivery into
 * the same, already-solved problem.
 *
 * Adopting the standard also means never bikeshedding field names, and keeping
 * interoperability with any CloudEvents-speaking system as a free option.
 * Our routing fields (lane, route, notify) are extension attributes, which the
 * spec explicitly allows.
 */

export const CE_SPEC_VERSION = "1.0" as const;

export interface CloudEvent {
	specversion: typeof CE_SPEC_VERSION;
	id: string;
	source: string;
	type: string;
	time?: string;
	data?: Record<string, unknown>;
}

export class CloudEventError extends Error {
	override readonly name = "CloudEventError";
}

/** Reverse-DNS event types, matching the spec's recommendation. */
export const CE_TYPES = {
	cronFired: "dev.pi-reactor.cron.fired",
	cliEmitted: "dev.pi-reactor.cli.emitted",
} as const;

/**
 * A cron fire's identity is deterministic: `{triggerId}:{scheduledAt}`.
 * Re-deriving it produces the same key, so a catch-up enqueue for an occurrence
 * that already landed collides with the unique index instead of double-firing.
 * That is why misfire handling needs no bookkeeping of its own.
 */
export function cronEvent(triggerId: string, scheduledAt: Date): CloudEvent {
	return {
		specversion: CE_SPEC_VERSION,
		id: `${triggerId}:${scheduledAt.toISOString()}`,
		source: `cron:${triggerId}`,
		type: CE_TYPES.cronFired,
		time: new Date().toISOString(),
	};
}

/**
 * A CLI emit is a distinct event every time unless the caller supplies an id.
 * Deliberately not content-hashed: `pi-reactor emit` twice on purpose should run
 * twice. Callers wanting idempotence pass their own id.
 */
export function cliEvent(id?: string, data?: Record<string, unknown>): CloudEvent {
	return {
		specversion: CE_SPEC_VERSION,
		id: id ?? `cli:${new Date().toISOString()}:${Math.random().toString(36).slice(2, 10)}`,
		source: "cli",
		type: CE_TYPES.cliEmitted,
		time: new Date().toISOString(),
		...(data ? { data } : {}),
	};
}

/** Validates the four required attributes and normalises the optional ones. */
export function validateCloudEvent(raw: unknown): CloudEvent {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new CloudEventError("cloud event must be an object");
	}
	const e = raw as Record<string, unknown>;
	if (e.specversion !== CE_SPEC_VERSION) {
		throw new CloudEventError(`unsupported specversion ${JSON.stringify(e.specversion)} (expected "1.0")`);
	}
	for (const key of ["id", "source", "type"] as const) {
		if (typeof e[key] !== "string" || (e[key] as string) === "") {
			throw new CloudEventError(`cloud event ${key} must be a non-empty string`);
		}
	}
	return {
		specversion: CE_SPEC_VERSION,
		id: e.id as string,
		source: e.source as string,
		type: e.type as string,
		...(typeof e.time === "string" ? { time: e.time } : {}),
		...(typeof e.data === "object" && e.data !== null && !Array.isArray(e.data)
			? { data: e.data as Record<string, unknown> }
			: {}),
	};
}

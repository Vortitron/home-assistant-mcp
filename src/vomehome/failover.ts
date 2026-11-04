import { HaFailoverError, HaRestartingError, type HaRestClient } from "../ha/restClient.js";
import type { Logger } from "../logger.js";

/**
 * "Home Assistant is restarting" when it is not: CHAP failover.
 *
 * While a CHAP pair's standby runs a home, the main install is stopped on
 * purpose, and every call to it fails exactly the way a restart does. Agents
 * were told "Home Assistant is restarting" for as long as the failover lasted
 * and only learnt otherwise from a person or from vomehome_chap_status (Nov
 * 2026). So a restart-shaped failure (a {@link HaRestartingError}) gets one
 * more question, of the portal's CHAP status for that instance
 * (`GET /api/v1/instances/<id>/chap`, what vomehome_chap_status shows): is a
 * failover active, and who runs the home? If the standby does, the error says
 * so and names it; otherwise (no pair, no failover, the status unreadable)
 * the restart wording stands.
 *
 * The answer is cached per instance for {@link FAILOVER_TTL_MS}, the "no pair"
 * answer and a failed read included, so a burst of failing calls makes one
 * status call, and a home with no CHAP costs one call per half minute of
 * failures at most. Only restart-shaped failures ask at all.
 */

export const FAILOVER_TTL_MS = 30_000;

export interface FailoverState {
	/** The standby now running the home. */
	standbyId: string;
	standbyName: string;
	/** The main install, as the pair names it (the asked-for instance may be its other row). */
	mainId: string;
}

/** Reads the portal's CHAP status for an instance (`VomeHomeClient.chap(id)`). */
export type ChapStatusReader = (instanceId: string) => Promise<Record<string, unknown>>;

/** Looks up whether a failover is active for an instance (cached). */
export type FailoverChecker = (instanceId: string) => Promise<FailoverState | null>;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function named(value: unknown): { id: string; name: string } | undefined {
	const entry = record(value);
	const id = typeof entry?.id === "string" ? entry.id : "";
	if (!id) return undefined;
	return { id, name: typeof entry?.name === "string" && entry.name ? entry.name : id };
}

/**
 * The failover in a CHAP status, or null.
 *
 * Relies on the portal's `status()` (portal/chap_api.py): `pair.failover`
 * true while the standby runs the home, and `pair.running` naming the install
 * that does (`{id, name}`), with `pair.main` / `pair.standby` beside it. A
 * standby's own status has `standby_of` and no pair; an account without CHAP,
 * an unenrolled instance or one with no standby has no pair either. The same
 * Home Assistant enrolled on its other row answers with that row's pair
 * (`managed_on`), which is still this home's failover.
 */
export function parseFailover(instanceId: string, status: Record<string, unknown>): FailoverState | null {
	const pair = record(status.pair);
	if (!pair || pair.failover !== true) return null;
	const running = named(pair.running) ?? named(pair.standby);
	if (!running || running.id === instanceId) return null;
	const main = named(pair.main);
	return { standbyId: running.id, standbyName: running.name, mainId: main?.id ?? instanceId };
}

export function createFailoverChecker(
	read: ChapStatusReader,
	options: { ttlMs?: number; logger?: Logger } = {}
): FailoverChecker {
	const ttl = options.ttlMs ?? FAILOVER_TTL_MS;
	const cache = new Map<string, { at: number; answer: Promise<FailoverState | null> }>();
	return (instanceId) => {
		const hit = cache.get(instanceId);
		if (hit && Date.now() - hit.at < ttl) return hit.answer;
		const answer = read(instanceId).then(
			(status) => parseFailover(instanceId, status),
			(error: unknown) => {
				// No CHAP on the account (403), not this key's (404), the portal down:
				// all mean "nothing to say", and the restart wording stands.
				options.logger?.debug(
					`CHAP status for ${instanceId} unavailable: ${error instanceof Error ? error.message : String(error)}`
				);
				return null;
			}
		);
		cache.set(instanceId, { at: Date.now(), answer });
		return answer;
	};
}

/** What a call to the main install says while its standby runs the home. */
export function failoverMessage(state: FailoverState, original: string, standbyKnown = true): string {
	return (
		`CHAP failover is active: the standby '${state.standbyName}' (${state.standbyId}) is running this home; ` +
		"the main is stopped on purpose. Read or act on the home through the standby: pass " +
		`instance_id="${state.standbyId}" (one call) or vomehome_use_instance. Use vomehome_chap_status for details.` +
		(standbyKnown ? "" : " (This session does not list the standby; the API key may need access to it in the portal.)") +
		` (Original error: ${original})`
	);
}

/**
 * The error a failed call should throw: a {@link HaFailoverError} when it
 * failed restart-shaped and the standby is running the home, else the
 * original error unchanged.
 */
export async function explainFailover(
	error: unknown,
	instanceId: string,
	check: FailoverChecker,
	isKnown: (id: string) => boolean = () => true
): Promise<unknown> {
	if (!(error instanceof HaRestartingError) || error instanceof HaFailoverError) return error;
	let state: FailoverState | null = null;
	try {
		state = await check(instanceId);
	} catch {
		state = null;
	}
	if (!state) return error;
	return new HaFailoverError(
		failoverMessage(state, error.original, isKnown(state.standbyId)),
		state.standbyId,
		state.standbyName,
		error.original
	);
}

/**
 * ``client`` with every call's restart-shaped failure checked for a CHAP
 * failover of ``instanceId`` (see {@link explainFailover}).
 */
export function withFailoverAwareness(
	client: HaRestClient,
	instanceId: string,
	check: FailoverChecker,
	isKnown?: (id: string) => boolean
): HaRestClient {
	return new Proxy(client, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const result = (value as (...a: unknown[]) => unknown).apply(target, args);
				if (!(result instanceof Promise)) return result;
				return result.catch(async (error: unknown) => {
					throw await explainFailover(error, instanceId, check, isKnown);
				});
			};
		}
	});
}

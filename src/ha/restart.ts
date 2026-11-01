import { HaApiError, HaRestartingError } from "./restClient.js";

/**
 * Telling "Home Assistant is restarting" apart from a real failure.
 *
 * While Home Assistant restarts, every call fails, and each route fails in its
 * own way: the hosted VM's nginx serves an HTML 404, the portal answers 502,
 * a relay-connected home's component drops off ("Home Assistant is offline
 * (no relay connection)"), a WebSocket command gets "WebSocket upgrade failed:
 * 404", and a direct connection is refused. An agent reading those raw took
 * them for errors in what it had asked, or for a broken home, when the only
 * right move was to wait a minute (reported from a week of real use, Oct 2026).
 *
 * So a failure that *looks* like a restart gets one cheap check — Home
 * Assistant's own `/api/config`, whose `state` is "NOT_RUNNING" or
 * "STARTING" while it comes up — and is reported as a restart only when that
 * says so. When Home Assistant answers RUNNING, the original error stands:
 * it was not a restart. When it does not answer either, the reply says it is
 * not answering and may be restarting, because a home that is offline for
 * good fails exactly the same way and cannot be told apart from here.
 */

/** Core states during which Home Assistant is not (yet, or any more) serving normally. */
const NOT_RUNNING_STATES = new Set(["NOT_RUNNING", "STARTING", "STOPPING", "FINAL_WRITE", "STOPPED"]);

/** Wording that only appears when Home Assistant itself is down or not reachable. */
const RESTART_TEXT =
	/WebSocket upgrade failed|no relay connection|Relay could not reach Home Assistant|No response from Home Assistant|Non-JSON response from Home Assistant|connection refused|ECONNREFUSED|Couldn't connect to server|Home Assistant is (?:starting|restarting|shutting down|not running)/i;

/** Vome's own plumbing failing, which says nothing about the home. */
const NOT_THE_HOME = /relay backend|relay is not configured|too old/i;

/** An HTML page where Home Assistant would have answered JSON: a proxy in front of it, with nothing behind. */
const HTML = /<html|<!doctype html|<center>nginx/i;

/** What a direct connection says when Home Assistant's port is closed or its WebSocket goes away. */
const NETWORK_TEXT =
	/ECONNREFUSED|WebSocket connection closed|WebSocket closed during authentication|Unexpected server response: (?:404|502|503|504)/;

export interface RestartCheckOptions {
	/**
	 * True when the failed request went straight to Home Assistant, so a
	 * refused connection means its port is closed. False for the brokered
	 * client, whose network errors are about reaching Vome, not the home.
	 */
	network?: boolean;
}

function causeCode(error: Error): string | undefined {
	const own = (error as { code?: unknown }).code;
	if (typeof own === "string") return own;
	const cause = (error as { cause?: unknown }).cause;
	const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
	return typeof code === "string" ? code : undefined;
}

/** True when an error has the shape of a Home Assistant restart (to be confirmed by a probe). */
export function looksLikeRestart(error: unknown, options: RestartCheckOptions = {}): boolean {
	if (error instanceof HaRestartingError) return true;
	if (error instanceof HaApiError) {
		const text = `${error.message}\n${error.body}`;
		if (NOT_THE_HOME.test(text)) return false;
		const status = error.status;
		if (status === 502 || status === 503 || status === 504) return true;
		if (status === 404 && HTML.test(error.body)) return true;
		// The wording alone, only where a restart could have produced it: an
		// integration's own 400 can say "connection refused" about a device.
		return (status === 0 || status === 404 || status >= 500) && RESTART_TEXT.test(text);
	}
	if (options.network && error instanceof Error) {
		return causeCode(error) === "ECONNREFUSED" || NETWORK_TEXT.test(error.message);
	}
	return false;
}

function isTimeout(error: unknown): boolean {
	return error instanceof HaApiError && /timed out/i.test(error.message);
}

/** The original failure in one short line: HTML reduced to its text, at most ~200 characters. */
export function briefly(error: unknown): string {
	let text = error instanceof Error ? error.message : String(error);
	if (error instanceof HaApiError && error.body && !text.includes(error.body.slice(0, 40))) {
		text += ` ${error.body}`;
	}
	text = text
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/** The message for a restart Home Assistant confirmed. */
export function restartingMessage(coreState: string, original: string): string {
	return (
		`Home Assistant is restarting (core state: ${coreState}). Retry in about 60 seconds, or call ` +
		`ha_wait_until_running. (Original error: ${original})`
	);
}

/** The message when Home Assistant did not answer the check either. */
export function notAnsweringMessage(original: string): string {
	return (
		"Home Assistant is not answering — it may be restarting; retry in about a minute, or call " +
		"ha_wait_until_running. If it keeps failing for several minutes, the home may be offline rather " +
		`than restarting. (Original error: ${original})`
	);
}

/** Reads Home Assistant's /api/config; the check made once per restart-shaped failure. */
export type CoreProbe = () => Promise<{ state?: unknown } | undefined>;

/**
 * The error to throw for a failed call: a {@link HaRestartingError} when the
 * failure is a restart, else the original error unchanged.
 *
 * `probe` is null when the failed call was the config read itself, so the
 * failure is the only evidence there is.
 */
export async function explainRestart(
	error: unknown,
	probe: CoreProbe | null,
	options: RestartCheckOptions = {}
): Promise<unknown> {
	if (error instanceof HaRestartingError || !looksLikeRestart(error, options)) {
		return error;
	}
	const original = briefly(error);
	if (probe) {
		try {
			const config = await probe();
			const state = typeof config?.state === "string" ? config.state : undefined;
			if (state && NOT_RUNNING_STATES.has(state)) {
				return new HaRestartingError(restartingMessage(state, original), state, original);
			}
			// Answering and running: whatever failed, it was not a restart.
			return error;
		} catch (probeError) {
			if (!looksLikeRestart(probeError, options) && !isTimeout(probeError)) {
				return error;
			}
		}
	}
	return new HaRestartingError(notAnsweringMessage(original), null, original);
}

/** True for a core state other than RUNNING (so a stamp can say Home Assistant is still starting). */
export function isNotRunning(state: unknown): state is string {
	return typeof state === "string" && NOT_RUNNING_STATES.has(state);
}

/** How long the one check may take: it only has to tell "answering" from "not". */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * MCP progress notifications for a long ESPHome build, so the client keeps waiting.
 *
 * A compile can run for many minutes and the tool answers only at the end.
 * Claude Code abandons a tool call that sends "no response or progress for
 * 300s" (found on a first ESP-IDF build on staging, 2 Oct 2026): the build
 * carried on at home while the agent was told it had failed. A progress
 * notification counts as a sign of life, and a client may show its message,
 * so each one carries the build's latest line.
 *
 * Sent only when the client asked for progress (a `progressToken` in the
 * request's `_meta`), at most every {@link MIN_GAP_MS} while output arrives and
 * at least every {@link HEARTBEAT_MS} while it does not.
 */

export interface ProgressExtra {
	_meta?: { progressToken?: string | number };
	sendNotification: (notification: {
		method: "notifications/progress";
		params: { progressToken: string | number; progress: number; message?: string };
	}) => Promise<void>;
}

export type BuildProgress = (lineCount: number, latest: string | null) => void;

const MIN_GAP_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const ANSI = new RegExp(`(${String.fromCharCode(27)}|\\\\033|\\\\x1b|\\\\u001b)\\[[0-9;]*[A-Za-z]`, "g");

export function buildProgressFor(extra: ProgressExtra | undefined, now: () => number = Date.now): BuildProgress | undefined {
	const token = extra?._meta?.progressToken;
	if (!extra || token === undefined) {
		return undefined;
	}
	let lastSent = Number.NEGATIVE_INFINITY;
	let lastCount = -1;
	return (lineCount, latest) => {
		const at = now();
		const isNew = lineCount !== lastCount;
		if (!((isNew && at - lastSent >= MIN_GAP_MS) || at - lastSent >= HEARTBEAT_MS)) {
			return;
		}
		lastSent = at;
		lastCount = lineCount;
		const message = latest?.replace(ANSI, "").replace(/\s+/g, " ").trim().slice(0, 160);
		void extra
			.sendNotification({
				method: "notifications/progress",
				params: { progressToken: token, progress: lineCount, ...(message ? { message } : {}) }
			})
			.catch(() => undefined);
	};
}

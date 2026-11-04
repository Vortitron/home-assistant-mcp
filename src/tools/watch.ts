import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HaApiError, HaRestartingError, type StateWatchGrant } from "../ha/restClient.js";
import type { HaState } from "../ha/types.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";
import { readStates } from "./states.js";
import { briefly } from "../ha/restart.js";

/**
 * Live states: wait for the next change instead of polling.
 *
 * A dashboard pane read a home's states every few seconds, each read a call
 * counted against the key, and a press still showed late. Through VomeHome a
 * watch makes the home's own component send each change to the entities
 * named; this tool waits for the next one (up to `wait_seconds`) and returns
 * what changed. The portal decides who may watch (the key needs ha:read on the
 * home, as reading states does) and signs a token for one watch on one home
 * for a few minutes; this tool renews it through the portal before it runs out.
 *
 * A home with no Vome component connected has nobody to send the changes: a
 * Vome-hosted home without the add-on answers "No relay connection" (an agent
 * timed a test against the clock instead, Nov 2026). There the tool polls the
 * states itself, every few seconds for the same wait, and answers in the same
 * shape with `mode: "polling"`, so a caller's loop works either way.
 */

interface LiveWatch {
	mode: "live";
	grant: StateWatchGrant;
	cursor: number;
}

interface PolledEntity {
	/** What a change is judged on: the state and its attributes. */
	fingerprint: string;
	/** The poll sequence number at which it last changed. */
	seq: number;
	state: HaState | null;
}

interface PollWatch {
	mode: "polling";
	/**
	 * The cursor handed back: the time (ms) of the last poll that saw a
	 * change, so it can never be mistaken for a live watch's small cursor.
	 */
	seq: number;
	/** The first poll's sequence: a cursor before it is not one this watch handed out. */
	base: number;
	entities: Map<string, PolledEntity>;
	/** Why the live watch could not be used. */
	reason: string;
	/** When to try the live watch again (the component may have connected since). */
	retryLiveAt: number;
}

type Watch = LiveWatch | PollWatch;

// One watch per session (context), home and set of entities.
const watches = new WeakMap<ToolContext, Map<string, Watch>>();
const RENEW_BEFORE_MS = 60_000;
/** How often polling reads the states. */
export const POLL_INTERVAL_MS = 3_000;
/** How long polling goes on before the live watch is tried again. */
const RETRY_LIVE_MS = 5 * 60_000;

/** Failures that mean "no component to send changes" (not "may not", not "home down"). */
const NO_LIVE_ROUTE =
	/no relay connection|no vome component|component (?:is )?not (?:connected|linked)|not linked|relay is not configured|relay backend error|live state watches go through vome/i;

/**
 * True when starting the live watch failed only because nothing can serve
 * one, so polling the states is a fair substitute. Never for a refusal (401,
 * 403: the key may not read this home, and polling must not paper over that)
 * nor for a restart (polling would fail the same way).
 */
export function canPollInstead(error: unknown): boolean {
	if (error instanceof HaRestartingError) return false;
	if (error instanceof HaApiError) {
		if (error.status === 401 || error.status === 403) return false;
		return NO_LIVE_ROUTE.test(`${error.message}\n${error.body}`);
	}
	return error instanceof Error && NO_LIVE_ROUTE.test(error.message);
}

function message(error: unknown): string {
	return briefly(error);
}

export function registerWatchTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_watch_states",
		{
			title: "Wait for state changes",
			description:
				"Wait up to wait_seconds for any of these entities to change, and return what changed: for a " +
				"client showing live states (a dashboard pane) instead of polling. The first call returns every " +
				"entity's current state; pass back the returned cursor to get only changes after it. Through " +
				"VomeHome the home's Vome component sends the changes (the key needs ha:read on the home); where " +
				"no component is connected (a hosted home without the Vome add-on, a direct connection) it reads " +
				"the states every few seconds instead and says mode: \"polling\".",
			inputSchema: {
				entity_ids: z.array(z.string()).min(1).max(200).describe("The entities to watch."),
				wait_seconds: z.number().int().min(0).max(25).optional().describe("How long to wait for a change (default 20)."),
				cursor: z.number().int().min(0).optional().describe("The cursor from the last call: only changes after it.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ entity_ids, wait_seconds, cursor }) =>
			runTool(ctx.logger, "ha_watch_states", async () => {
				const ids = [...new Set(entity_ids)].sort();
				const key = `${ctx.instances.activeId()}|${ids.join(",")}`;
				const mine = watches.get(ctx) ?? new Map<string, Watch>();
				watches.set(ctx, mine);
				const wait = wait_seconds ?? 20;
				let watch = mine.get(key);

				// Start (or renew) the live watch, unless polling and not yet time to try again.
				const live = watch?.mode === "live" ? watch : undefined;
				const tryLive =
					!watch ||
					(watch.mode === "polling" && Date.now() >= watch.retryLiveAt) ||
					(live !== undefined && live.grant.expires_at * 1000 - Date.now() < RENEW_BEFORE_MS);
				if (tryLive) {
					try {
						const grant = await ctx.rest.startStateWatch(ids, live?.grant.job_id);
						watch = { mode: "live", grant, cursor: grant.job_id === live?.grant.job_id ? live.cursor : 0 };
						mine.set(key, watch);
					} catch (error) {
						if (!canPollInstead(error)) {
							return errorResult(`Could not start a live watch: ${message(error)}`);
						}
						watch = startPolling(watch, message(error));
						mine.set(key, watch);
					}
				}
				if (!watch) return errorResult("Could not start a live watch.");
				if (watch.mode === "polling") {
					return jsonResult(await poll(ctx, watch, ids, cursor, wait));
				}

				let from = cursor ?? watch.cursor;
				let body = await read(watch.grant, from, wait);
				if (body === "gone") {
					// The watch ended (idle, the home reconnected): start afresh, from the whole picture.
					try {
						const grant = await ctx.rest.startStateWatch(ids);
						watch = { mode: "live", grant, cursor: 0 };
						mine.set(key, watch);
						from = 0;
						body = await read(grant, from, wait);
					} catch (error) {
						if (!canPollInstead(error)) throw error;
						const polling = startPolling(undefined, message(error));
						mine.set(key, polling);
						return jsonResult(await poll(ctx, polling, ids, undefined, wait));
					}
				}
				if (body === "gone") {
					return errorResult("The live watch keeps ending; the home may be offline.");
				}
				watch.cursor = body.cursor;
				return jsonResult(body);
			})
	);
}

/** A polling watch: the one already running (its baseline kept), else a fresh one. */
function startPolling(previous: Watch | undefined, reason: string): PollWatch {
	const retryLiveAt = Date.now() + RETRY_LIVE_MS;
	if (previous?.mode === "polling") {
		return { ...previous, reason, retryLiveAt };
	}
	return { mode: "polling", seq: 0, base: 0, entities: new Map(), reason, retryLiveAt };
}

function fingerprint(state: HaState | null): string {
	return state ? JSON.stringify([state.state, state.attributes ?? {}]) : "null";
}

/** Reads the states once and records what changed since the last read. */
async function pollOnce(ctx: ToolContext, watch: PollWatch, ids: string[]): Promise<void> {
	const states = await readStates(ctx, ids);
	const first = watch.seq === 0;
	const next = Math.max(watch.seq + 1, Date.now());
	let changed = false;
	for (const id of ids) {
		const state = states.get(id) ?? null;
		const print = fingerprint(state);
		const known = watch.entities.get(id);
		if (!known || known.fingerprint !== print) {
			watch.entities.set(id, { fingerprint: print, seq: next, state });
			changed = true;
		} else {
			known.state = state;
		}
	}
	if (first || changed) watch.seq = next;
	if (first) watch.base = next;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The polling answer, in the live watch's shape: the whole picture when the
 * cursor is absent, 0 or not one this watch handed out; else the entities
 * that changed after it, waiting (reading every few seconds) up to `wait`
 * seconds for one to.
 */
async function poll(
	ctx: ToolContext,
	watch: PollWatch,
	ids: string[],
	cursor: number | undefined,
	waitSeconds: number
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + waitSeconds * 1000;
	const note =
		`Polling: no live watch for this home (${watch.reason.slice(0, 160)}), so its states are read every ` +
		`${POLL_INTERVAL_MS / 1000} s instead. Changes shorter than that can be missed.`;
	const answer = (full: boolean, states: Array<HaState | null>): Record<string, unknown> => {
		const missing = ids.filter((id) => watch.entities.get(id)?.state === null);
		return {
			cursor: watch.seq,
			full,
			states: states.filter((state): state is HaState => state !== null),
			done: false,
			error: null,
			mode: "polling",
			note,
			...(missing.length > 0 ? { missing } : {})
		};
	};
	for (;;) {
		await pollOnce(ctx, watch, ids);
		const from = cursor ?? 0;
		if (from < watch.base || from > watch.seq) {
			return answer(true, ids.map((id) => watch.entities.get(id)?.state ?? null));
		}
		const changed = ids.filter((id) => (watch.entities.get(id)?.seq ?? 0) > from);
		const left = deadline - Date.now();
		if (changed.length > 0 || left <= 0) {
			return answer(false, changed.map((id) => watch.entities.get(id)?.state ?? null));
		}
		await sleep(Math.min(POLL_INTERVAL_MS, left));
	}
}

type ReadBody = { cursor: number; full: boolean; states: unknown[]; done: boolean; error: string | null };

async function read(grant: StateWatchGrant, cursor: number, waitSeconds: number): Promise<ReadBody | "gone"> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), (waitSeconds + 15) * 1000);
	try {
		const response = await fetch(`${grant.read_url}?cursor=${cursor}&wait=${waitSeconds}`, {
			headers: { Authorization: `Bearer ${grant.token}` },
			signal: controller.signal
		});
		if (response.status === 401 || response.status === 404) return "gone";
		if (!response.ok) throw new Error(`The watch answered HTTP ${response.status}.`);
		return (await response.json()) as ReadBody;
	} finally {
		clearTimeout(timer);
	}
}

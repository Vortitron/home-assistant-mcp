import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StateWatchGrant } from "../ha/restClient.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

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
 */

interface Watch {
	grant: StateWatchGrant;
	cursor: number;
}

// One watch per session (context), home and set of entities.
const watches = new WeakMap<ToolContext, Map<string, Watch>>();
const RENEW_BEFORE_MS = 60_000;

export function registerWatchTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_watch_states",
		{
			title: "Wait for state changes",
			description:
				"Wait up to wait_seconds for any of these entities to change, and return what changed: for a " +
				"client showing live states (a dashboard pane) instead of polling. The first call returns every " +
				"entity's current state; pass back the returned cursor to get only changes after it. Through " +
				"VomeHome only (the home's Vome component sends the changes); the key needs ha:read on the home.",
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
				let watch = mine.get(key);
				try {
					if (!watch || watch.grant.expires_at * 1000 - Date.now() < RENEW_BEFORE_MS) {
						const grant = await ctx.rest.startStateWatch(ids, watch?.grant.job_id);
						watch = { grant, cursor: grant.job_id === watch?.grant.job_id ? watch.cursor : 0 };
						mine.set(key, watch);
					}
				} catch (error) {
					return errorResult(`Could not start a live watch: ${error instanceof Error ? error.message : String(error)}`);
				}
				const wait = wait_seconds ?? 20;
				let from = cursor ?? watch.cursor;
				let body = await read(watch.grant, from, wait);
				if (body === "gone") {
					// The watch ended (idle, the home reconnected): start afresh, from the whole picture.
					const grant = await ctx.rest.startStateWatch(ids);
					watch = { grant, cursor: 0 };
					mine.set(key, watch);
					from = 0;
					body = await read(grant, from, wait);
				}
				if (body === "gone") {
					return errorResult("The live watch keeps ending; the home may be offline.");
				}
				watch.cursor = body.cursor;
				return jsonResult(body);
			})
	);
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

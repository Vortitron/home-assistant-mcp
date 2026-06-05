import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HaState } from "../ha/types.js";
import { getFriendlyName, jsonResult, runTool, truncate, type ToolContext } from "./helpers.js";
import { buildEntityAreaMap, findAreaId } from "./registry.js";

function compactState(state: HaState): Record<string, unknown> {
	return {
		entity_id: state.entity_id,
		state: state.state,
		friendly_name: getFriendlyName(state.attributes) ?? null,
		last_changed: state.last_changed ?? null
	};
}

export function registerStateTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_entities",
		{
			title: "List entities",
			description:
				"List entities with their current state. Filter by domain (e.g. 'light'), a free-text search over entity_id and friendly name, and/or an area (id or name). This is the fastest way to discover what exists before calling services or editing automations.",
			inputSchema: {
				domain: z.string().optional().describe("Restrict to one domain, e.g. 'light', 'sensor'."),
				search: z
					.string()
					.optional()
					.describe("Case-insensitive substring matched against entity_id and friendly_name."),
				area: z.string().optional().describe("Area id or name to filter by."),
				limit: z.number().int().positive().optional().describe("Maximum rows to return."),
				include_attributes: z
					.boolean()
					.optional()
					.describe("Include full attributes for each entity (default false, compact rows).")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ domain, search, area, limit, include_attributes }) =>
			runTool(ctx.logger, "ha_list_entities", async () => {
				const states = await ctx.rest.getStates();
				const needle = search?.trim().toLowerCase();

				let areaId: string | undefined;
				let areaMap: Map<string, string | null> | undefined;
				if (area) {
					const areas = await ctx.ws.listAreas();
					areaId = findAreaId(areas, area);
					if (!areaId) {
						return jsonResult({ total: 0, returned: 0, entities: [], note: `No area matched '${area}'.` });
					}
					areaMap = await buildEntityAreaMap(ctx.ws);
				}

				const filtered = states.filter((state) => {
					if (domain && !state.entity_id.startsWith(`${domain}.`)) {
						return false;
					}
					if (areaId && areaMap && areaMap.get(state.entity_id) !== areaId) {
						return false;
					}
					if (needle) {
						const haystack = `${state.entity_id} ${getFriendlyName(state.attributes) ?? ""}`.toLowerCase();
						if (!haystack.includes(needle)) {
							return false;
						}
					}
					return true;
				});

				const effectiveLimit = Math.min(limit ?? ctx.config.maxResults, ctx.config.maxResults);
				const limited = truncate(filtered, effectiveLimit);
				const rows = limited.items.map((state) =>
					include_attributes ? state : compactState(state)
				);
				return jsonResult({
					total: limited.total,
					returned: limited.returned,
					truncated: limited.truncated,
					entities: rows
				});
			})
	);

	server.registerTool(
		"ha_get_state",
		{
			title: "Get entity state",
			description:
				"Get the full state and attributes for one or more entities. Use this to read exact current values before changing them or writing template/automation logic.",
			inputSchema: {
				entity_ids: z
					.array(z.string())
					.min(1)
					.describe("One or more entity_ids, e.g. ['light.kitchen','sensor.outside_temp'].")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ entity_ids }) =>
			runTool(ctx.logger, "ha_get_state", async () => {
				const results = await Promise.all(
					entity_ids.map(async (entityId) => {
						try {
							return { entity_id: entityId, found: true, state: await ctx.rest.getState(entityId) };
						} catch {
							return { entity_id: entityId, found: false, state: null };
						}
					})
				);
				return jsonResult({ entities: results });
			})
	);

	server.registerTool(
		"ha_get_history",
		{
			title: "Get entity history",
			description:
				"Get historical state changes for one or more entities over a time window. Times are ISO 8601 (e.g. 2026-06-05T06:00:00+00:00). Defaults to the last day if no start_time is given.",
			inputSchema: {
				entity_ids: z.array(z.string()).min(1).describe("Entities to fetch history for."),
				start_time: z.string().optional().describe("ISO 8601 start timestamp."),
				end_time: z.string().optional().describe("ISO 8601 end timestamp."),
				minimal: z
					.boolean()
					.optional()
					.describe("Return minimal response (state + last_changed only) to reduce size.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ entity_ids, start_time, end_time, minimal }) =>
			runTool(ctx.logger, "ha_get_history", async () => {
				const history = await ctx.rest.getHistory({
					entityIds: entity_ids,
					startTime: start_time,
					endTime: end_time,
					minimalResponse: minimal ?? true,
					significantChangesOnly: false
				});
				return jsonResult({ series: history });
			})
	);
}

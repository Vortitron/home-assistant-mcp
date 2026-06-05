import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HaWsClient } from "../ha/wsClient.js";
import type { HaArea } from "../ha/types.js";
import { jsonResult, runTool, truncate, type ToolContext } from "./helpers.js";

/** Resolve an area query (id or name, case-insensitive) to an area_id. */
export function findAreaId(areas: HaArea[], query: string): string | undefined {
	const normalised = query.trim().toLowerCase();
	const byId = areas.find((area) => area.area_id.toLowerCase() === normalised);
	if (byId) {
		return byId.area_id;
	}
	const byName = areas.find((area) => (area.name ?? "").toLowerCase() === normalised);
	return byName?.area_id;
}

/**
 * Build entity_id -> area_id, honouring Home Assistant's rule that an entity
 * inherits its device's area unless it overrides the area itself.
 */
export async function buildEntityAreaMap(ws: HaWsClient): Promise<Map<string, string | null>> {
	const [entities, devices] = await Promise.all([ws.listEntities(), ws.listDevices()]);
	const deviceArea = new Map<string, string | null>();
	for (const device of devices) {
		deviceArea.set(device.id, device.area_id ?? null);
	}
	const map = new Map<string, string | null>();
	for (const entry of entities) {
		const inherited = entry.device_id ? (deviceArea.get(entry.device_id) ?? null) : null;
		map.set(entry.entity_id, entry.area_id ?? inherited);
	}
	return map;
}

export function registerRegistryTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_areas",
		{
			title: "List areas",
			description:
				"List all Home Assistant areas (rooms/zones) with their ids, names and floor. Use the area_id or name to filter other tools.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_list_areas", async () => {
				const areas = await ctx.ws.listAreas();
				const rows = areas.map((area) => ({
					area_id: area.area_id,
					name: area.name,
					floor_id: area.floor_id ?? null
				}));
				return jsonResult({ count: rows.length, areas: rows });
			})
	);

	server.registerTool(
		"ha_list_devices",
		{
			title: "List devices",
			description:
				"List Home Assistant devices from the device registry. Optionally filter by area (id or name) and/or a search string matching name, manufacturer or model.",
			inputSchema: {
				area: z.string().optional().describe("Area id or name to filter by."),
				search: z
					.string()
					.optional()
					.describe("Case-insensitive substring matched against name, manufacturer and model.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ area, search }) =>
			runTool(ctx.logger, "ha_list_devices", async () => {
				const devices = await ctx.ws.listDevices();
				let areaId: string | undefined;
				if (area) {
					const areas = await ctx.ws.listAreas();
					areaId = findAreaId(areas, area);
					if (!areaId) {
						return jsonResult({ count: 0, devices: [], note: `No area matched '${area}'.` });
					}
				}
				const needle = search?.trim().toLowerCase();
				const filtered = devices.filter((device) => {
					if (areaId && (device.area_id ?? null) !== areaId) {
						return false;
					}
					if (needle) {
						const haystack = [device.name_by_user, device.name, device.manufacturer, device.model]
							.filter((value): value is string => typeof value === "string")
							.join(" ")
							.toLowerCase();
						if (!haystack.includes(needle)) {
							return false;
						}
					}
					return true;
				});
				const limited = truncate(filtered, ctx.config.maxResults);
				const rows = limited.items.map((device) => ({
					id: device.id,
					name: device.name_by_user ?? device.name ?? null,
					manufacturer: device.manufacturer ?? null,
					model: device.model ?? null,
					area_id: device.area_id ?? null
				}));
				return jsonResult({
					total: limited.total,
					returned: limited.returned,
					truncated: limited.truncated,
					devices: rows
				});
			})
	);

	server.registerTool(
		"ha_get_entity_registry",
		{
			title: "Get entity registry",
			description:
				"Inspect the entity registry: platform, area, device, unique-id metadata and whether entities are disabled or hidden. Useful for finding disabled entities or the area/device an entity belongs to.",
			inputSchema: {
				entity_id: z.string().optional().describe("Exact entity_id to look up."),
				domain: z.string().optional().describe("Filter to a single domain, e.g. 'light'."),
				include_disabled: z
					.boolean()
					.optional()
					.describe("Include disabled entities (default true).")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ entity_id, domain, include_disabled }) =>
			runTool(ctx.logger, "ha_get_entity_registry", async () => {
				const entries = await ctx.ws.listEntities();
				const includeDisabled = include_disabled ?? true;
				const filtered = entries.filter((entry) => {
					if (entity_id && entry.entity_id !== entity_id) {
						return false;
					}
					if (domain && !entry.entity_id.startsWith(`${domain}.`)) {
						return false;
					}
					if (!includeDisabled && entry.disabled_by) {
						return false;
					}
					return true;
				});
				const limited = truncate(filtered, ctx.config.maxResults);
				const rows = limited.items.map((entry) => ({
					entity_id: entry.entity_id,
					platform: entry.platform ?? null,
					area_id: entry.area_id ?? null,
					device_id: entry.device_id ?? null,
					name: entry.name ?? entry.original_name ?? null,
					entity_category: entry.entity_category ?? null,
					disabled_by: entry.disabled_by ?? null,
					hidden_by: entry.hidden_by ?? null
				}));
				return jsonResult({
					total: limited.total,
					returned: limited.returned,
					truncated: limited.truncated,
					entities: rows
				});
			})
	);
}

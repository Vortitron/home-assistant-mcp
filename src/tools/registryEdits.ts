import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Changing the entity registry, and asking a Matter device to describe
 * itself again.
 *
 * The registry was read-only here, so orphaned entities (an automation
 * deleted from YAML, a device long gone) could not be cleaned up, and an
 * entity could not be renamed, moved or disabled, short of the owner
 * clicking through the UI. Matter re-interview is the device page's
 * "Re-interview" button: after a firmware update a device can report new or
 * changed endpoints (a button that went silent) that Home Assistant only
 * learns about when it asks again.
 */

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

function refuse(ctx: ToolContext) {
	const decision = evaluateConfigWrite(ctx.instances.currentSafety());
	return decision.allowed ? null : errorResult(`Refused: ${decision.reason}`);
}

export function registerRegistryEditTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_update_entity",
		{
			title: "Rename, move, disable or hide an entity",
			description:
				"Change an entity's registry entry: its display name, its entity_id, its area, its icon, or " +
				"whether it is disabled or hidden. Omit a field to leave it alone; pass null for name, area_id " +
				"or icon to clear it back to the default. Renaming the entity_id does not update automations, " +
				"scripts or dashboards that use the old one, so check those first (ha_list_automations). " +
				"Disabling stops the entity being created at all; hiding only keeps it off auto-generated " +
				"dashboards. Requires HA_ALLOW_CONFIG_WRITE (ha:config).",
			inputSchema: {
				entity_id: z.string().regex(ENTITY_ID).describe("The entity to change, e.g. 'sensor.kitchen_temp'."),
				name: z.string().nullable().optional().describe("Display name; null resets it to the integration's."),
				new_entity_id: z.string().regex(ENTITY_ID).optional().describe("A new entity_id in the same domain."),
				area_id: z.string().nullable().optional().describe("Area id from ha_list_areas; null removes it."),
				icon: z.string().nullable().optional().describe("e.g. 'mdi:radiator'; null resets it."),
				disabled: z.boolean().optional().describe("true disables it (by the user); false enables it again."),
				hidden: z.boolean().optional().describe("true hides it (by the user); false shows it again.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ entity_id, name, new_entity_id, area_id, icon, disabled, hidden }) =>
			runTool(ctx.logger, "ha_update_entity", async () => {
				const refusal = refuse(ctx);
				if (refusal) return refusal;
				if (new_entity_id && new_entity_id.split(".")[0] !== entity_id.split(".")[0]) {
					return errorResult("Refused: new_entity_id must stay in the same domain as entity_id.");
				}
				const command: Record<string, unknown> = { type: "config/entity_registry/update", entity_id };
				if (name !== undefined) command.name = name;
				if (new_entity_id !== undefined) command.new_entity_id = new_entity_id;
				if (area_id !== undefined) command.area_id = area_id;
				if (icon !== undefined) command.icon = icon;
				if (disabled !== undefined) command.disabled_by = disabled ? "user" : null;
				if (hidden !== undefined) command.hidden_by = hidden ? "user" : null;
				if (Object.keys(command).length === 2) {
					return errorResult("Nothing to change: pass at least one of name, new_entity_id, area_id, icon, disabled, hidden.");
				}
				const result = await ctx.ws.sendCommand<Record<string, unknown>>(command);
				return jsonResult({ updated: true, ...result });
			})
	);

	server.registerTool(
		"ha_update_device",
		{
			title: "Rename a device, move it to an area, or disable it",
			description:
				"Change a device's registry entry: its name (the one the owner sets, over the integration's), " +
				"its area, or whether it is disabled. Entities that follow their device's area move with it; " +
				"an entity given its own area keeps it (ha_update_entity). Disabling a device disables all its " +
				"entities. Omit a field to leave it alone; pass null for name or area_id to clear it. Takes the " +
				"device id from ha_list_devices. Requires HA_ALLOW_CONFIG_WRITE (ha:config).",
			inputSchema: {
				device_id: z.string().min(1).describe("Home Assistant device id (ha_list_devices)."),
				name: z
					.string()
					.nullable()
					.optional()
					.describe("The owner's name for it (name_by_user); null goes back to the integration's name."),
				area_id: z.string().nullable().optional().describe("Area id from ha_list_areas; null removes it."),
				disabled: z.boolean().optional().describe("true disables it (by the user); false enables it again."),
				labels: z.array(z.string()).optional().describe("Label ids; replaces the device's labels.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ device_id, name, area_id, disabled, labels }) =>
			runTool(ctx.logger, "ha_update_device", async () => {
				const refusal = refuse(ctx);
				if (refusal) return refusal;
				const command: Record<string, unknown> = { type: "config/device_registry/update", device_id };
				if (name !== undefined) command.name_by_user = name;
				if (area_id !== undefined) command.area_id = area_id;
				if (disabled !== undefined) command.disabled_by = disabled ? "user" : null;
				if (labels !== undefined) command.labels = labels;
				if (Object.keys(command).length === 2) {
					return errorResult("Nothing to change: pass at least one of name, area_id, disabled, labels.");
				}
				const result = await ctx.ws.sendCommand<Record<string, unknown>>(command);
				return jsonResult({ updated: true, device: result });
			})
	);

	server.registerTool(
		"ha_expose_entities",
		{
			title: "Choose what voice assistants can see",
			description:
				"Read or change which entities are exposed to voice assistants — the Voice assistants → Expose " +
				"page. With no entity_ids it lists every entity's exposure. With entity_ids and should_expose it " +
				"sets them for the given assistants: 'conversation' (Assist, and the Vome LLM API), " +
				"'cloud.alexa', 'cloud.google_assistant'. Exposing lets that assistant control the entity, so " +
				"keep locks, alarms and covers off unless the owner asks. Changing it requires " +
				"HA_ALLOW_CONFIG_WRITE (ha:config); listing needs only read.",
			inputSchema: {
				entity_ids: z.array(z.string().regex(ENTITY_ID)).optional().describe("Entities to change; omit to list."),
				should_expose: z.boolean().optional().describe("true exposes, false stops exposing. Needed with entity_ids."),
				assistants: z
					.array(z.string().min(1))
					.optional()
					.describe("Default ['conversation']."),
				exposed_only: z.boolean().optional().describe("When listing: only entities exposed to at least one assistant (default true).")
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
		},
		async ({ entity_ids, should_expose, assistants, exposed_only }) =>
			runTool(ctx.logger, "ha_expose_entities", async () => {
				if (!entity_ids || entity_ids.length === 0) {
					const listed = await ctx.ws.sendCommand<{ exposed_entities?: Record<string, Record<string, boolean>> }>({
						type: "homeassistant/expose_entity/list"
					});
					const all = listed?.exposed_entities ?? {};
					const only = exposed_only ?? true;
					const entries = Object.entries(all).filter(
						([, by]) => !only || Object.values(by ?? {}).some(Boolean)
					);
					return jsonResult({ count: entries.length, exposed_entities: Object.fromEntries(entries) });
				}
				if (should_expose === undefined) {
					return errorResult("Pass should_expose (true or false) with entity_ids.");
				}
				const refusal = refuse(ctx);
				if (refusal) return refusal;
				const chosen = assistants && assistants.length > 0 ? assistants : ["conversation"];
				await ctx.ws.sendCommand({
					type: "homeassistant/expose_entity",
					assistants: chosen,
					entity_ids,
					should_expose
				});
				return jsonResult({ updated: true, assistants: chosen, entity_ids, should_expose });
			})
	);

	server.registerTool(
		"ha_remove_entity",
		{
			title: "Remove an entity from the registry",
			description:
				"Remove an entity's registry entry, for cleaning up orphans: an entity whose integration no " +
				"longer provides it (status 'unavailable' with restored: true), or one left behind by a " +
				"deleted device. An entity its integration still provides comes straight back, so disable it " +
				"with ha_update_entity instead. Requires HA_ALLOW_CONFIG_WRITE (ha:config).",
			inputSchema: {
				entity_id: z.string().regex(ENTITY_ID).describe("The entity to remove.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ entity_id }) =>
			runTool(ctx.logger, "ha_remove_entity", async () => {
				const refusal = refuse(ctx);
				if (refusal) return refusal;
				await ctx.ws.sendCommand({ type: "config/entity_registry/remove", entity_id });
				return jsonResult({ removed: true, entity_id });
			})
	);

	server.registerTool(
		"ha_matter_reinterview",
		{
			title: "Re-interview a Matter device",
			description:
				"Ask a Matter device to describe itself again — the device page's Re-interview button. Do this " +
				"after a firmware update, or when a button, endpoint or feature stopped appearing: Home " +
				"Assistant only learns about changed endpoints when it asks. A battery device may need waking " +
				"(press a button) first. Takes the Home Assistant device id from ha_list_devices. Requires " +
				"HA_ALLOW_CONFIG_WRITE (ha:config).",
			inputSchema: {
				device_id: z.string().min(1).describe("Home Assistant device id (ha_list_devices), not the Matter node id.")
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
		},
		async ({ device_id }) =>
			runTool(ctx.logger, "ha_matter_reinterview", async () => {
				const refusal = refuse(ctx);
				if (refusal) return refusal;
				await ctx.ws.sendCommand({ type: "matter/interview_node", device_id });
				return jsonResult({
					reinterviewed: true,
					device_id,
					next: "Check the device's entities with ha_list_entities, or its log with ha_get_supervisor_log target='addon' addon_slug='core_matter_server'."
				});
			})
	);
}

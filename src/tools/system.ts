import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateDomainWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_get_config",
		{
			title: "Get Home Assistant config",
			description:
				"Return core Home Assistant configuration: version, location name, time zone, unit system and the list of loaded integrations/components. A good first call to understand the instance.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_get_config", async () => {
				const config = await ctx.rest.getConfig();
				return jsonResult({
					version: config.version ?? null,
					location_name: config.location_name ?? null,
					time_zone: config.time_zone ?? null,
					unit_system: config.unit_system ?? null,
					state: config.state ?? null,
					component_count: Array.isArray(config.components) ? config.components.length : null,
					components: config.components ?? []
				});
			})
	);

	server.registerTool(
		"ha_fire_event",
		{
			title: "Fire an event",
			description:
				"Fire a custom event on the Home Assistant event bus (advanced). Useful for triggering event-based automations during testing. Requires writes to be enabled.",
			inputSchema: {
				event_type: z.string().describe("Event type, e.g. 'my_custom_event'."),
				event_data: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Optional event data payload.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ event_type, event_data }) =>
			runTool(ctx.logger, "ha_fire_event", async () => {
				if (!ctx.config.safety.allowWrite) {
					return errorResult(
						"Refused: firing events requires HA_ALLOW_WRITE=true."
					);
				}
				const result = await ctx.rest.fireEvent(event_type, event_data);
				return jsonResult(result);
			})
	);

	server.registerTool(
		"ha_reload_automations",
		{
			title: "Reload automations",
			description:
				"Reload automations from configuration without restarting Home Assistant (calls automation.reload). Requires writes to be enabled.",
			inputSchema: {},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_reload_automations", async () => {
				const decision = evaluateDomainWrite("automation", ctx.config.safety);
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				await ctx.rest.callService("automation", "reload");
				return jsonResult({ reloaded: true });
			})
	);
}

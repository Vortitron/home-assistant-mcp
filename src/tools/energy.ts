import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * The Energy dashboard's configuration: which statistics are grid import and
 * export, solar, batteries, gas and water, and which devices are tracked.
 *
 * It lives in Home Assistant's .storage (never served as a file), so the only
 * way to see or change it was the dashboard's settings page. Home Assistant
 * keeps it as a handful of lists and `energy/save_prefs` replaces each list
 * it is given whole — so the tool sends only the lists named and the way to
 * add one device is read, append, save. The dashboard's own checks
 * (`energy/validate`: wrong unit, wrong state_class, a statistic that has
 * gone) come back with every read and after every save, since a list that
 * saves fine can still draw an empty graph.
 */

type Prefs = Record<string, unknown>;

/** HA answers get_prefs with an error until the dashboard has been set up once. */
async function readPrefs(ctx: ToolContext): Promise<Prefs | null> {
	try {
		return await ctx.ws.sendCommand<Prefs>({ type: "energy/get_prefs" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/not_found|no prefs|not configured/i.test(message)) return null;
		throw error;
	}
}

async function validate(ctx: ToolContext): Promise<unknown> {
	try {
		return await ctx.ws.sendCommand({ type: "energy/validate" });
	} catch (error) {
		return { unavailable: error instanceof Error ? error.message : String(error) };
	}
}

const LIST = z.array(z.record(z.string(), z.unknown()));

export function registerEnergyTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_get_energy_prefs",
		{
			title: "Read the Energy dashboard's setup",
			description:
				"Read the Energy dashboard's configuration — energy_sources (grid with its import/export " +
				"statistics and tariffs, solar, battery, gas, water) and device_consumption (the devices it " +
				"breaks usage down by) — together with the dashboard's own validation: a statistic with the " +
				"wrong unit or state_class, or one that no longer exists, shows here and as an empty graph " +
				"there. 'configured: false' means the dashboard has never been set up.",
			inputSchema: {
				include_validation: z.boolean().optional().describe("Run the dashboard's checks too (default true).")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ include_validation }) =>
			runTool(ctx.logger, "ha_get_energy_prefs", async () => {
				const prefs = await readPrefs(ctx);
				const result: Record<string, unknown> = { configured: prefs !== null, prefs: prefs ?? {} };
				if (include_validation ?? true) result.validation = await validate(ctx);
				return jsonResult(result);
			})
	);

	server.registerTool(
		"ha_set_energy_prefs",
		{
			title: "Change the Energy dashboard's setup",
			description:
				"Save the Energy dashboard's configuration. Each list you pass REPLACES that list whole; " +
				"lists you leave out stay as they are. So read it first with ha_get_energy_prefs, change " +
				"the list, and send back all of it — sending one device in device_consumption drops every " +
				"other device. Entries use statistic ids, which for a sensor are its entity_id: e.g. " +
				"device_consumption [{\"stat_consumption\": \"sensor.washer_energy\", \"name\": \"Washer\"}], " +
				"a grid source {\"type\": \"grid\", \"flow_from\": [{\"stat_energy_from\": \"sensor.import_kwh\", " +
				"\"stat_cost\": null, \"entity_energy_price\": null, \"number_energy_price\": null}], " +
				"\"flow_to\": [], \"cost_adjustment_day\": 0}. Energy statistics need state_class total or " +
				"total_increasing and an energy unit. The dashboard's validation comes back afterwards: " +
				"check it. Requires HA_ALLOW_CONFIG_WRITE (ha:config).",
			inputSchema: {
				energy_sources: LIST.optional().describe("Every energy source (grid, solar, battery, gas, water)."),
				device_consumption: LIST.optional().describe("Every tracked device."),
				device_consumption_water: LIST
					.optional()
					.describe("Every tracked water-using device (Home Assistant 2025.x and later).")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ energy_sources, device_consumption, device_consumption_water }) =>
			runTool(ctx.logger, "ha_set_energy_prefs", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) return errorResult(`Refused: ${decision.reason}`);
				const command: Record<string, unknown> = { type: "energy/save_prefs" };
				if (energy_sources !== undefined) command.energy_sources = energy_sources;
				if (device_consumption !== undefined) command.device_consumption = device_consumption;
				if (device_consumption_water !== undefined) command.device_consumption_water = device_consumption_water;
				if (Object.keys(command).length === 1) {
					return errorResult("Nothing to save: pass energy_sources, device_consumption or device_consumption_water.");
				}
				const saved = await ctx.ws.sendCommand<Prefs>(command);
				return jsonResult({ saved: true, prefs: saved, validation: await validate(ctx) });
			})
	);
}

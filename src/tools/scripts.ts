import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Scripts, by the same config API as automations.
 *
 * Without these, a step several automations share ("raise the desired
 * temperature") had to be copied into each of them, because the only other
 * way to add a script was rewriting the whole of scripts.yaml. A script is
 * called with script.<id> or the script.turn_on service, so the shared step
 * lives in one place.
 */

const SCRIPT_ID = /^[a-z0-9_]{1,128}$/;

/** "script.raise_heat" or "raise_heat" → "raise_heat". */
function scriptIdOf(value: string): string {
	return value.startsWith("script.") ? value.slice("script.".length) : value;
}

const scriptIdSchema = z
	.string()
	.describe("Script id: the key in scripts.yaml and the object id of script.<id>, e.g. 'raise_heat'. 'script.raise_heat' also works.");

export function registerScriptTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_get_script",
		{
			title: "Get script config",
			description:
				"Get a script's full configuration (alias, sequence, fields, mode). List scripts with " +
				"ha_list_entities domain='script'.",
			inputSchema: { script: scriptIdSchema },
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ script }) =>
			runTool(ctx.logger, "ha_get_script", async () => {
				const id = scriptIdOf(script);
				if (!SCRIPT_ID.test(id)) {
					return errorResult(`'${script}' is not a script id: lowercase letters, digits and underscores only.`);
				}
				const config = await ctx.rest.getScriptConfig(id);
				return jsonResult({ id, config });
			})
	);

	server.registerTool(
		"ha_set_script",
		{
			title: "Create or update script",
			description:
				"Create or update a script by id. 'config' is the script body ({ alias, sequence, fields, " +
				"mode, ... }); Home Assistant reloads scripts after saving. Use it for a step several " +
				"automations share, then call it from each with action 'script.<id>'. Requires " +
				"HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true.",
			inputSchema: {
				script_id: scriptIdSchema,
				config: z
					.record(z.string(), z.unknown())
					.describe("Script config object: { alias, sequence, fields, mode, ... }.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ script_id, config }) =>
			runTool(ctx.logger, "ha_set_script", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const id = scriptIdOf(script_id);
				if (!SCRIPT_ID.test(id)) {
					return errorResult(`'${script_id}' is not a script id: lowercase letters, digits and underscores only.`);
				}
				const result = await ctx.rest.upsertScriptConfig(id, config);
				return jsonResult({
					saved: true,
					script_id: id,
					result,
					hint: `Run it with ha_call_service script.${id}, or check it with ha_get_state script.${id}.`
				});
			})
	);

	server.registerTool(
		"ha_delete_script",
		{
			title: "Delete script",
			description:
				"Delete a script by id. Automations that call it will fail at that step, so remove those " +
				"calls first. Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true.",
			inputSchema: { script_id: scriptIdSchema },
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ script_id }) =>
			runTool(ctx.logger, "ha_delete_script", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const id = scriptIdOf(script_id);
				if (!SCRIPT_ID.test(id)) {
					return errorResult(`'${script_id}' is not a script id: lowercase letters, digits and underscores only.`);
				}
				const result = await ctx.rest.deleteScriptConfig(id);
				return jsonResult({ deleted: true, script_id: id, result });
			})
	);
}

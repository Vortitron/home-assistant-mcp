import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HaState } from "../ha/types.js";
import { evaluateConfigWrite, evaluateDomainWrite } from "../safety.js";
import { errorResult, getFriendlyName, jsonResult, runTool, type ToolContext } from "./helpers.js";

const AUTOMATION_PREFIX = "automation.";

function automationIdOf(state: HaState): string | undefined {
	const id = state.attributes.id;
	return typeof id === "string" ? id : undefined;
}

async function findAutomationState(
	ctx: ToolContext,
	reference: string
): Promise<HaState | undefined> {
	const states = await ctx.rest.getStates();
	const automations = states.filter((state) => state.entity_id.startsWith(AUTOMATION_PREFIX));
	if (reference.startsWith(AUTOMATION_PREFIX)) {
		return automations.find((state) => state.entity_id === reference);
	}
	return automations.find((state) => automationIdOf(state) === reference);
}

export function registerAutomationTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_automations",
		{
			title: "List automations",
			description:
				"List all automations with their entity_id, unique id (needed to read/edit config), on/off state and last triggered time.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_list_automations", async () => {
				const states = await ctx.rest.getStates();
				const rows = states
					.filter((state) => state.entity_id.startsWith(AUTOMATION_PREFIX))
					.map((state) => ({
						entity_id: state.entity_id,
						id: automationIdOf(state) ?? null,
						state: state.state,
						friendly_name: getFriendlyName(state.attributes) ?? null,
						last_triggered: state.attributes.last_triggered ?? null
					}));
				return jsonResult({ count: rows.length, automations: rows });
			})
	);

	server.registerTool(
		"ha_get_automation",
		{
			title: "Get automation config",
			description:
				"Get the full configuration (triggers, conditions, actions) of an automation. Accepts either the entity_id (automation.xxx) or the unique id.",
			inputSchema: {
				automation: z.string().describe("entity_id (automation.xxx) or unique id.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ automation }) =>
			runTool(ctx.logger, "ha_get_automation", async () => {
				let id = automation;
				if (automation.startsWith(AUTOMATION_PREFIX)) {
					const state = await findAutomationState(ctx, automation);
					const resolved = state ? automationIdOf(state) : undefined;
					if (!resolved) {
						return errorResult(`Could not resolve a unique id for '${automation}'.`);
					}
					id = resolved;
				}
				const config = await ctx.rest.getAutomationConfig(id);
				return jsonResult({ id, config });
			})
	);

	server.registerTool(
		"ha_set_automation",
		{
			title: "Create or update automation",
			description:
				"Create or update an automation by unique id. 'config' is the automation body (alias, trigger, condition, action, mode). Home Assistant reloads automations automatically after saving. Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true.",
			inputSchema: {
				automation_id: z
					.string()
					.describe("Unique id of the automation (existing id to update, or a new id to create)."),
				config: z
					.record(z.string(), z.unknown())
					.describe("Automation config object: { alias, trigger, condition, action, mode, ... }.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ automation_id, config }) =>
			runTool(ctx.logger, "ha_set_automation", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const result = await ctx.rest.upsertAutomationConfig(automation_id, config);
				return jsonResult({
					saved: true,
					automation_id,
					result,
					hint: "Verify with ha_get_state on automation." + automation_id + " or ha_check_config."
				});
			})
	);

	server.registerTool(
		"ha_delete_automation",
		{
			title: "Delete automation",
			description:
				"Delete an automation by its unique id. Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true.",
			inputSchema: {
				automation_id: z.string().describe("Unique id of the automation to delete.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ automation_id }) =>
			runTool(ctx.logger, "ha_delete_automation", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const result = await ctx.rest.deleteAutomationConfig(automation_id);
				return jsonResult({ deleted: true, automation_id, result });
			})
	);

	server.registerTool(
		"ha_trigger_automation",
		{
			title: "Trigger automation",
			description:
				"Manually run an automation's actions now (automation.trigger). Accepts entity_id or unique id. Set skip_condition=false to also evaluate conditions. Requires writes to be enabled.",
			inputSchema: {
				automation: z.string().describe("entity_id (automation.xxx) or unique id."),
				skip_condition: z
					.boolean()
					.optional()
					.describe("Skip the automation's conditions (default true).")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ automation, skip_condition }) =>
			runTool(ctx.logger, "ha_trigger_automation", async () => {
				const decision = evaluateDomainWrite("automation", ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const state = await findAutomationState(ctx, automation);
				if (!state) {
					return errorResult(`No automation matched '${automation}'.`);
				}
				await ctx.rest.callService(
					"automation",
					"trigger",
					{ skip_condition: skip_condition ?? true },
					{ entity_id: state.entity_id }
				);
				return jsonResult({ triggered: state.entity_id });
			})
	);
}

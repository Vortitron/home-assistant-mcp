import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HaState } from "../ha/types.js";
import { HaApiError } from "../ha/restClient.js";
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

/**
 * Resolve an automation reference (entity_id *or* unique id) to the unique id
 * that the config and trace APIs key on. Returns undefined when an
 * `automation.*` entity_id has no resolvable unique id (YAML automations
 * without an `id:`).
 */
export async function resolveAutomationId(
	ctx: ToolContext,
	reference: string
): Promise<string | undefined> {
	if (!reference.startsWith(AUTOMATION_PREFIX)) {
		return reference;
	}
	const state = await findAutomationState(ctx, reference);
	return state ? automationIdOf(state) : undefined;
}

function isNotFound(error: unknown): boolean {
	return error instanceof HaApiError && error.status === 404;
}

/** `automation.x (id "…", alias "…")`, with whatever is known. */
function describeAutomation(reference: string, state: HaState | undefined, id?: string): string {
	const entityId = state?.entity_id ?? (reference.startsWith(AUTOMATION_PREFIX) ? reference : undefined);
	const alias = state ? getFriendlyName(state.attributes) : undefined;
	const bits = [
		id !== undefined && id !== entityId ? `id "${id}"` : undefined,
		alias ? `alias "${alias}"` : undefined
	].filter(Boolean);
	return `${entityId ?? `automation id "${id ?? reference}"`}${bits.length > 0 ? ` (${bits.join(", ")})` : ""}`;
}

/**
 * Why the automation editor's API has no config for an automation that
 * exists: it was written in YAML outside automations.yaml (a package, an
 * !include). The config API only serves automations.yaml, and a 404 from it
 * read as "no such automation" to an agent looking at the entity.
 */
export function notInEditorMessage(reference: string, state: HaState | undefined, id: string | undefined): string {
	return (
		`${describeAutomation(reference, state, id)} is not defined in the automation editor (automations.yaml); ` +
		`it comes from YAML — ${whereInYaml(state, id)}`
	);
}

/** Where a YAML automation probably lives, and how to find and change it. */
function whereInYaml(state: HaState | undefined, id: string | undefined): string {
	const search = [state ? getFriendlyName(state.attributes) : undefined, id].filter(Boolean).join('" or "');
	return (
		`most likely a package (often under packages/), configuration.yaml itself or another included file. Use ` +
		`ha_list_config_files / ha_read_config_file to find it${search ? ` (search for "${search}")` : " (search for its alias or id)"}. ` +
		`The editor tools cannot change it: edit that file (ha_edit_config_file), then reload automations.`
	);
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
				"Get the full configuration (triggers, conditions, actions) of an automation made in the automation editor (automations.yaml). Accepts either the entity_id (automation.xxx) or the unique id. An automation written in a YAML package or another included file is not served by the editor's API; for one of those this says so and how to find its file.",
			inputSchema: {
				automation: z.string().describe("entity_id (automation.xxx) or unique id.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ automation }) =>
			runTool(ctx.logger, "ha_get_automation", async () => {
				let state: HaState | undefined;
				let id: string | undefined = automation;
				if (automation.startsWith(AUTOMATION_PREFIX)) {
					state = await findAutomationState(ctx, automation);
					if (!state) {
						return errorResult(`No automation matched '${automation}'. ha_list_automations lists them.`);
					}
					id = automationIdOf(state);
					if (!id) {
						// No `id:` at all: a YAML automation the editor could never open.
						return errorResult(
							`${describeAutomation(automation, state)} has no unique id: it is written in YAML without an ` +
								`'id:', so the automation editor cannot open it. It comes from YAML — ` +
								whereInYaml(state, undefined)
						);
					}
				}
				try {
					const config = await ctx.rest.getAutomationConfig(id);
					return jsonResult({ id, config });
				} catch (error) {
					if (!isNotFound(error)) throw error;
					if (!state) {
						// Asked by unique id: find the entity, if there is one, to name it.
						state = await findAutomationState(ctx, id).catch(() => undefined);
						if (!state) {
							return errorResult(
								`No automation has the unique id '${id}' — neither in the automation editor nor among ` +
									`the running automations. ha_list_automations lists them with their ids.`
							);
						}
					}
					return errorResult(notInEditorMessage(automation, state, id));
				}
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
				try {
					const result = await ctx.rest.deleteAutomationConfig(automation_id);
					return jsonResult({ deleted: true, automation_id, result });
				} catch (error) {
					if (!isNotFound(error)) throw error;
					const state = await findAutomationState(ctx, automation_id).catch(() => undefined);
					if (!state) {
						return errorResult(`Nothing deleted: no automation has the unique id '${automation_id}'.`);
					}
					return errorResult(`Nothing deleted: ${notInEditorMessage(automation_id, state, automation_id)}`);
				}
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

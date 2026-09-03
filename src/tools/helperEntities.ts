import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Home Assistant "helpers" — input_boolean, input_number, counter, timer and
 * friends — created and edited over the WebSocket API.
 *
 * The old way to add one was a block in `configuration.yaml` plus a restart,
 * which an agent cannot do: nothing here can reach that file, and it is the
 * answer people are still most often given. Home Assistant has stored these in
 * its own database since the UI gained helpers, and exposes CRUD for each of
 * them on the WebSocket API — no file, no restart, and the entity exists
 * immediately.
 *
 * Every helper domain registers the same four commands via Home Assistant's
 * storage-collection helper: `<domain>/list`, `/create`, `/update` and
 * `/delete`, with the item keyed as `<domain>_id`. That uniformity is why these
 * tools take the kind as a parameter rather than being nine near-identical
 * tools.
 */

/**
 * Helper domains backed by a storage collection, so they can be created at
 * runtime. Deliberately a fixed list: these are the ones with WebSocket CRUD,
 * and naming them lets an agent see what it can make rather than guess a
 * domain and get an opaque `unknown_command`.
 */
const HELPER_KINDS = [
	"input_boolean",
	"input_number",
	"input_text",
	"input_select",
	"input_datetime",
	"input_button",
	"counter",
	"timer",
	"schedule"
] as const;

type HelperKind = (typeof HELPER_KINDS)[number];

/**
 * The fields each kind needs, for the tool description.
 *
 * A hint, not a schema: Home Assistant validates on its side and names the
 * offending field, which is the authority. Duplicating its schemas here would
 * only drift out of date — the failure mode this codebase has been bitten by
 * before.
 */
const FIELD_HINTS: Record<HelperKind, string> = {
	input_boolean: "name; optional icon, initial",
	input_number: "name, min, max; optional step, initial, mode (box|slider), unit_of_measurement, icon",
	input_text: "name; optional min, max, initial, pattern, mode (text|password), icon",
	input_select: "name, options (array of strings); optional initial, icon",
	input_datetime: "name, and at least one of has_date / has_time; optional initial, icon",
	input_button: "name; optional icon",
	counter: "name; optional initial, step, minimum, maximum, restore, icon",
	timer: "name; optional duration (HH:MM:SS), restore, icon",
	schedule: "name; optional monday…sunday (arrays of {from, to}), icon"
};

const KIND_LIST = HELPER_KINDS.join(", ");

export function registerHelperEntityTools(server: McpServer, ctx: ToolContext): void {
	const idKey = (kind: HelperKind): string => `${kind}_id`;

	server.registerTool(
		"ha_list_helpers",
		{
			title: "List Home Assistant helpers",
			description:
				"List the helpers Home Assistant stores — input_boolean, input_number, counter, timer " +
				"and the rest. These are the ones created through the UI (or by ha_set_helper); helpers " +
				"defined in configuration.yaml are not returned here, because Home Assistant keeps those " +
				"separately and they cannot be edited at runtime.\n\n" +
				`Omit 'kind' to list every type. Types: ${KIND_LIST}.`,
			inputSchema: {
				kind: z
					.enum(HELPER_KINDS)
					.optional()
					.describe("One helper type to list. Omit for all of them.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ kind }) =>
			runTool(ctx.logger, "ha_list_helpers", async () => {
				const kinds = kind ? [kind] : [...HELPER_KINDS];
				const out: Record<string, unknown> = {};
				for (const each of kinds) {
					try {
						out[each] = await ctx.ws.sendCommand({ type: `${each}/list` });
					} catch (error) {
						// One unavailable domain must not hide the other eight: a
						// component that is not loaded answers unknown_command.
						out[each] = {
							error: error instanceof Error ? error.message : String(error)
						};
					}
				}
				return jsonResult(kind ? out[kind] : out);
			})
	);

	server.registerTool(
		"ha_set_helper",
		{
			title: "Create or update a helper",
			description:
				"Create a Home Assistant helper, or update one that exists. **This is how to add a helper " +
				"without editing configuration.yaml** — that file is not reachable from here and would " +
				"need a restart; a helper created this way is stored by Home Assistant and its entity " +
				"exists immediately.\n\n" +
				"Omit 'helper_id' to create; pass the id from ha_list_helpers to update. The new entity " +
				"is <kind>.<slug of name>.\n\n" +
				"Fields per kind — Home Assistant validates and will name anything wrong:\n" +
				HELPER_KINDS.map((k) => `  • ${k}: ${FIELD_HINTS[k]}`).join("\n"),
			inputSchema: {
				kind: z.enum(HELPER_KINDS).describe(`Helper type: ${KIND_LIST}.`),
				config: z
					.record(z.string(), z.unknown())
					.describe("The helper's fields, e.g. { name: 'Holiday mode', icon: 'mdi:palm-tree' }."),
				helper_id: z
					.string()
					.optional()
					.describe("Existing helper id to update. Omit to create a new one.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ kind, config, helper_id }) =>
			runTool(ctx.logger, "ha_set_helper", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const command: Record<string, unknown> = helper_id
					? { type: `${kind}/update`, [idKey(kind)]: helper_id, ...config }
					: { type: `${kind}/create`, ...config };
				const result = await ctx.ws.sendCommand<Record<string, unknown>>(command);
				return jsonResult({
					saved: true,
					kind,
					created: !helper_id,
					helper: result,
					hint:
						"The entity is available now — no restart. Confirm with ha_get_state on " +
						`${kind}.<slug of the name>.`
				});
			})
	);

	server.registerTool(
		"ha_delete_helper",
		{
			title: "Delete a helper",
			description:
				"Delete a stored Home Assistant helper by id (from ha_list_helpers). The entity disappears " +
				"immediately, and anything referencing it — automations, dashboards, template sensors — " +
				"will start reporting an unknown entity, so check what uses it first. Helpers defined in " +
				"configuration.yaml cannot be deleted this way.",
			inputSchema: {
				kind: z.enum(HELPER_KINDS).describe(`Helper type: ${KIND_LIST}.`),
				helper_id: z.string().describe("Helper id from ha_list_helpers.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ kind, helper_id }) =>
			runTool(ctx.logger, "ha_delete_helper", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				await ctx.ws.sendCommand({
					type: `${kind}/delete`,
					[idKey(kind)]: helper_id
				});
				return jsonResult({ deleted: true, kind, helper_id });
			})
	);
}

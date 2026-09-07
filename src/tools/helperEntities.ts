import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HaEntityRegistryEntry } from "../ha/types.js";
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

/** One item as `<kind>/list` returns it. Only the two fields we need are typed. */
interface StoredHelper {
	id?: string;
	name?: string;
	[key: string]: unknown;
}

/**
 * Slugify closely enough to compare two names.
 *
 * Home Assistant's own slugify transliterates accents and we do not, so this
 * is only ever used to raise a warning — never to decide that something is
 * safe.
 */
function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/**
 * What deleting `helper_id` is actually going to remove.
 *
 * WHY THIS EXISTS
 * ---------------
 * A stored helper and a `configuration.yaml` helper of the same domain share
 * one id namespace *and* one entity-registry slot. Home Assistant's
 * `sync_entity_lifecycle` deletes by looking up `(domain, platform,
 * item_id)` in the entity registry — and both collections pass the same
 * domain and platform. So if `input_boolean.holiday_mode` is defined in YAML
 * and a stored helper also carries the id `holiday_mode`, deleting the stored
 * one removes the YAML entity's registry entry, and the YAML entity goes with
 * it.
 *
 * Reloading does not bring it back. A reload re-loads the YAML collection,
 * sees the item id it already has, and raises CHANGE_UPDATED — and the update
 * path returns early for an entity that is no longer in its map. Only a full
 * restart, which loads the collection from empty and so raises CHANGE_ADDED,
 * recreates it. That is a long way to travel from "I deleted a helper".
 *
 * At startup the YAML collection loads first and wins the registry slot, so
 * in a collision it is the *stored* helper that has no entity — it is a
 * phantom row in `<kind>/list` whose deletion destroys somebody else's entity.
 */
interface RegistrySlot {
	/** Whether the check could run at all. Never report safety we did not test. */
	checked: boolean;
	/** The slot looks like it belongs to a differently-named helper. */
	shared: boolean;
	entityId: string | null;
	registryName: string | null;
	note: string;
}

async function inspectRegistrySlot(
	ctx: ToolContext,
	kind: HelperKind,
	helperId: string,
	storedName: string | undefined
): Promise<RegistrySlot> {
	const unchecked = (note: string): RegistrySlot => ({
		checked: false,
		shared: false,
		entityId: null,
		registryName: null,
		note
	});

	let entries: HaEntityRegistryEntry[];
	try {
		entries = await ctx.ws.listEntities();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return unchecked(`Could not read the entity registry (${message}), so the shared-id check did not run.`);
	}
	if (!Array.isArray(entries)) {
		return unchecked("The entity registry did not answer, so the shared-id check did not run.");
	}
	// Older registries omit unique_id from the list response. Without it there
	// is no way to tell which entity a delete will take, and saying nothing
	// would read as an all-clear.
	if (!entries.some((entry) => typeof entry.unique_id === "string")) {
		return unchecked("This Home Assistant does not return unique ids from the entity registry, so the shared-id check did not run.");
	}

	const owner = entries.find(
		(entry) => entry.platform === kind && entry.unique_id === helperId
	);
	if (!owner) {
		return {
			checked: true,
			shared: false,
			entityId: null,
			registryName: null,
			note: `No entity is registered under the id '${helperId}', so the delete has no registry entry to take.`
		};
	}

	// original_name is what the platform called it; name is a user's override,
	// which a rename would change legitimately. Compare against the former.
	const registryName =
		typeof owner.original_name === "string"
			? owner.original_name
			: typeof owner.name === "string"
				? owner.name
				: null;
	const wanted = slugify(storedName ?? "");
	const found = slugify(registryName ?? "");
	const shared = wanted !== "" && found !== "" && wanted !== found;

	return {
		checked: true,
		shared,
		entityId: typeof owner.entity_id === "string" ? owner.entity_id : null,
		registryName,
		note: shared
			? `The entity registered under id '${helperId}' is named '${registryName}', but the stored helper is named '${storedName}'. That is what a helper defined in configuration.yaml holding the same id looks like.`
			: `Deleting this removes ${owner.entity_id}.`
	};
}

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
				"They are kept separately but they are NOT independent: both kinds share one id " +
				"namespace and one entity-registry slot per id. A row listed here can therefore be a " +
				"phantom whose entity actually belongs to a configuration.yaml helper of the same id — " +
				"see ha_delete_helper.\n\n" +
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
				"Delete a stored Home Assistant helper by id (from ha_list_helpers). The entity " +
				"disappears immediately, and anything referencing it — automations, dashboards, " +
				"template sensors — will start reporting an unknown entity, so check what uses it " +
				"first.\n\n" +
				"**A helper defined in configuration.yaml can be destroyed by this.** Stored helpers " +
				"and YAML helpers share one id namespace and one entity-registry slot, and Home " +
				"Assistant deletes by that slot. Deleting a stored helper whose id matches a YAML " +
				"helper's key removes the YAML entity's registry entry as well, and the entity goes " +
				"with it. Reloading will NOT bring it back — a reload sees an id it already has and " +
				"changes nothing. Only a full restart recreates the entity. This tool checks for that " +
				"before deleting and refuses when it finds it; pass confirm_shared_id to go ahead " +
				"anyway.\n\n" +
				"An id that is not in ha_list_helpers is refused: a helper defined only in " +
				"configuration.yaml is removed by editing that file and restarting.",
			inputSchema: {
				kind: z.enum(HELPER_KINDS).describe(`Helper type: ${KIND_LIST}.`),
				helper_id: z.string().describe("Helper id from ha_list_helpers."),
				confirm_shared_id: z
					.boolean()
					.optional()
					.describe(
						"Delete even though the id looks shared with a configuration.yaml helper. " +
							"Only after checking that file: the YAML entity will need a full Home " +
							"Assistant restart to come back."
					)
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ kind, helper_id, confirm_shared_id }) =>
			runTool(ctx.logger, "ha_delete_helper", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}

				// The old description claimed YAML helpers "cannot be deleted this
				// way" and nothing enforced it. Enforce the true half of that here:
				// an id we cannot see in the stored collection is not ours to touch.
				const stored = await ctx.ws.sendCommand<StoredHelper[]>({ type: `${kind}/list` });
				const item = Array.isArray(stored)
					? stored.find((entry) => entry.id === helper_id)
					: undefined;
				if (!item) {
					return errorResult(
						`No stored ${kind} has the id '${helper_id}'. ha_list_helpers shows the ones ` +
							"that can be deleted here. If it is defined in configuration.yaml, remove " +
							"the block from that file and restart Home Assistant — it cannot be " +
							"deleted over the API."
					);
				}

				const slot = await inspectRegistrySlot(ctx, kind, helper_id, item.name);
				if (slot.shared && !confirm_shared_id) {
					return errorResult(
						`Refused: '${helper_id}' looks like a shared id. ${slot.note} Deleting the ` +
							`stored helper would remove ${slot.entityId ?? "that entity"} and only a ` +
							"full Home Assistant restart would bring it back — a reload will not. " +
							"Check configuration.yaml for this id, then pass confirm_shared_id: true " +
							"if you still want it gone."
					);
				}

				await ctx.ws.sendCommand({
					type: `${kind}/delete`,
					[idKey(kind)]: helper_id
				});

				return jsonResult({
					deleted: true,
					kind,
					helper_id,
					removed_entity: slot.entityId,
					shared_id_check: slot.checked ? (slot.shared ? "overridden" : "passed") : "not run",
					note: slot.checked
						? slot.note
						: `${slot.note} If ${kind}.${helper_id} is also defined in configuration.yaml, ` +
							"its entity has gone too and needs a full Home Assistant restart — not a " +
							"reload — to come back."
				});
			})
	);
}

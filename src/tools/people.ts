import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * People: Settings → People, and which device trackers say where each is.
 *
 * GamlaBio, 29 Oct 2026: an agent replacing an old phone could disable the
 * phone's device, but not take its tracker off the person it belonged to.
 * No tool reached people, and the file Home Assistant keeps them in
 * (`.storage/person`) is rightly off-limits to the file tools. These are
 * Home Assistant's own `person/*` commands, the ones the People page uses.
 *
 * A person defined under `person:` in configuration.yaml is listed but is not
 * editable here, for the same reason as a YAML helper: Home Assistant keeps it
 * apart and only a file edit and a restart change it.
 */

export interface StoredPerson {
	id: string;
	name: string;
	user_id?: string | null;
	device_trackers?: string[];
	picture?: string | null;
}

interface PersonList {
	storage?: StoredPerson[];
	config?: StoredPerson[];
}

const TRACKER = /^device_tracker\.[a-z0-9_]+$/;

function shape(person: StoredPerson, editable: boolean): Record<string, unknown> {
	return {
		person_id: person.id,
		name: person.name,
		user_id: person.user_id ?? null,
		device_trackers: person.device_trackers ?? [],
		picture: person.picture ?? null,
		editable
	};
}

async function listPeople(ctx: ToolContext): Promise<{ storage: StoredPerson[]; config: StoredPerson[] }> {
	const listed = await ctx.ws.sendCommand<PersonList>({ type: "person/list" });
	return {
		storage: Array.isArray(listed?.storage) ? listed.storage : [],
		config: Array.isArray(listed?.config) ? listed.config : []
	};
}

function badTrackers(ids: readonly string[]): string[] {
	return ids.filter((id) => !TRACKER.test(id));
}

/** The tracker list after a replace, then adds, then removes; order kept, no repeats. */
export function nextTrackers(
	current: readonly string[],
	replace: readonly string[] | undefined,
	add: readonly string[] | undefined,
	remove: readonly string[] | undefined
): string[] {
	const out: string[] = [];
	for (const id of [...(replace ?? current), ...(add ?? [])]) {
		if (!out.includes(id)) out.push(id);
	}
	const dropped = new Set(remove ?? []);
	return out.filter((id) => !dropped.has(id));
}

/** Trackers that also belong to someone else: allowed, but rarely meant. */
function sharedWith(people: StoredPerson[], selfId: string | null, trackers: readonly string[]): Record<string, string[]> {
	const shared: Record<string, string[]> = {};
	for (const other of people) {
		if (other.id === selfId) continue;
		for (const id of other.device_trackers ?? []) {
			if (trackers.includes(id)) (shared[id] ??= []).push(other.name);
		}
	}
	return shared;
}

const trackerList = z.array(z.string()).optional();

export function registerPeopleTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_people",
		{
			title: "List people",
			description:
				"List the people in Home Assistant (Settings → People): each one's person_id, name, the " +
				"Home Assistant user it is linked to (user_id, or null), its device_trackers (the " +
				"device_tracker entities whose location decides where the person is) and picture. " +
				"`editable` is false for a person defined under `person:` in configuration.yaml, which " +
				"only a file edit and a restart can change. The person's own entity is " +
				"person.<slug of name>.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_list_people", async () => {
				const { storage, config } = await listPeople(ctx);
				return jsonResult({
					people: [...storage.map((p) => shape(p, true)), ...config.map((p) => shape(p, false))]
				});
			})
	);

	server.registerTool(
		"ha_set_person",
		{
			title: "Create or update a person",
			description:
				"Create a person, or change one: name, linked user, picture, and above all which " +
				"device_tracker entities track them. Omit person_id to create; pass one from " +
				"ha_list_people to update, and only the fields given change.\n\n" +
				"Trackers: `device_trackers` replaces the whole list; `add_device_trackers` and " +
				"`remove_device_trackers` change it one entity at a time (applied after any " +
				"replacement), which is the safe way to swap an old phone for a new one. Every id " +
				"must be a device_tracker.* entity. A tracker may belong to more than one person; " +
				"the answer says when it does.\n\n" +
				"`user_id` (from ha_list_users) links the person to a login, null unlinks; a user can " +
				"belong to one person only. A person from configuration.yaml is refused. Needs " +
				"HA_ALLOW_CONFIG_WRITE.",
			inputSchema: {
				person_id: z.string().optional().describe("Person to update, from ha_list_people. Omit to create."),
				name: z.string().min(1).optional().describe("Display name. Required when creating."),
				user_id: z.string().nullable().optional().describe("Home Assistant user to link, or null to unlink."),
				picture: z.string().nullable().optional().describe("Picture URL or /api/image/serve/… path, or null."),
				device_trackers: trackerList.describe("Replace the tracker list with exactly these entity ids."),
				add_device_trackers: trackerList.describe("Tracker entity ids to add."),
				remove_device_trackers: trackerList.describe("Tracker entity ids to take off.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
		},
		async ({ person_id, name, user_id, picture, device_trackers, add_device_trackers, remove_device_trackers }) =>
			runTool(ctx.logger, "ha_set_person", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const wrong = badTrackers([
					...(device_trackers ?? []),
					...(add_device_trackers ?? [])
				]);
				if (wrong.length > 0) {
					return errorResult(
						`Not device_tracker entities: ${wrong.join(", ")}. A person is tracked by ` +
							"device_tracker.* entities only (ha_list_entities with domain device_tracker)."
					);
				}

				const { storage, config } = await listPeople(ctx);
				let existing: StoredPerson | undefined;
				if (person_id) {
					existing = storage.find((p) => p.id === person_id);
					if (!existing) {
						const yaml = config.find((p) => p.id === person_id);
						return errorResult(
							yaml
								? `'${yaml.name}' is defined under person: in configuration.yaml, so Home ` +
										"Assistant cannot change it at runtime. Edit that file and restart, or " +
										"move the person to the People page."
								: `No person has the id '${person_id}'. ha_list_people lists them.`
						);
					}
				} else if (!name) {
					return errorResult("A new person needs a name.");
				}

				const trackersTouched =
					device_trackers !== undefined || add_device_trackers !== undefined || remove_device_trackers !== undefined;
				const trackers = nextTrackers(
					existing?.device_trackers ?? [],
					device_trackers,
					add_device_trackers,
					remove_device_trackers
				);

				const fields: Record<string, unknown> = {};
				if (name !== undefined) fields.name = name;
				if (user_id !== undefined) fields.user_id = user_id;
				if (picture !== undefined) fields.picture = picture;
				// Always sent, even untouched: Home Assistant's person/update gives
				// device_trackers a default of [] (UPDATE_FIELDS in person/__init__.py), so
				// an update without it empties the list and the person goes "unknown". A
				// change of only user_id did exactly that to a real home (4 Nov 2026).
				fields.device_trackers = trackers;

				const result = await ctx.ws.sendCommand<StoredPerson>(
					existing
						? { type: "person/update", person_id: existing.id, ...fields }
						: { type: "person/create", ...fields }
				);
				const saved = result && typeof result === "object" && "id" in result ? result : undefined;
				const shared = sharedWith([...storage, ...config], existing?.id ?? saved?.id ?? null, trackers);
				const notFound = (remove_device_trackers ?? []).filter(
					(id) => !(existing?.device_trackers ?? []).includes(id)
				);
				return jsonResult({
					saved: true,
					created: !existing,
					person: saved ? shape(saved, true) : result,
					...(Object.keys(shared).length > 0 ? { also_tracking_someone_else: shared } : {}),
					...(notFound.length > 0 ? { not_on_this_person: notFound } : {}),
					hint: "Takes effect at once, no restart. The person's location follows the trackers on its next update."
				});
			})
	);

	server.registerTool(
		"ha_delete_person",
		{
			title: "Delete a person",
			description:
				"Delete a person by person_id (from ha_list_people). Their person.* entity goes at once, " +
				"so automations, zones' counts and dashboards that use it will start reporting an " +
				"unknown entity: check first. The linked Home Assistant user and the device trackers " +
				"are not deleted. A person from configuration.yaml is refused. Needs HA_ALLOW_CONFIG_WRITE.",
			inputSchema: {
				person_id: z.string().describe("Person to delete, from ha_list_people.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ person_id }) =>
			runTool(ctx.logger, "ha_delete_person", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const { storage, config } = await listPeople(ctx);
				const person = storage.find((p) => p.id === person_id);
				if (!person) {
					const yaml = config.find((p) => p.id === person_id);
					return errorResult(
						yaml
							? `'${yaml.name}' is defined under person: in configuration.yaml. Remove it there and restart.`
							: `No person has the id '${person_id}'. ha_list_people lists them.`
					);
				}
				await ctx.ws.sendCommand({ type: "person/delete", person_id });
				return jsonResult({ deleted: true, person_id, name: person.name });
			})
	);
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * CHAP tools: a standby Home Assistant kept in step with the one running a
 * home, ready to take over. Each tool is one action of the VomeHome portal's
 * CHAP page, through the portal's JSON API (`/api/v1/instances/<id>/chap`),
 * so an agent sets CHAP up exactly as a person does by hand, with the same
 * checks. Reads are always allowed; changes defer to the API key's scopes
 * (and any local write guard for the instance), like the other VomeHome tools.
 *
 * The house side is the user's to prepare: both Home Assistants installed,
 * each connected to Vome with the Vome add-on and running the Vome CHAP
 * add-on. Everything after that is here.
 */

const instanceId = z.string().describe("VomeHome instance id of the home's main install (from vomehome_list_instances).");

function refuse(ctx: ToolContext, id: string): string | undefined {
	const decision = evaluateConfigWrite(ctx.instances.safetyFor(id));
	if (decision.allowed) return undefined;
	return ctx.instances.brokered
		? `Refused: CHAP changes are blocked locally for '${id}' (write/config false in VOMEHOME_INSTANCES). ` +
				"Otherwise the API key decides."
		: "Refused: CHAP changes need HA_ALLOW_WRITE and HA_ALLOW_CONFIG_WRITE in direct mode.";
}

export function registerVomeHomeChapTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"vomehome_chap_status",
		{
			title: "CHAP status",
			description:
				"How CHAP stands for an instance: whether it is enrolled, its pair (main install, standby, " +
				"which one runs the home, the kind of pair), whether the two are paired and in step, each " +
				"part's state as the CHAP page's picture shows it, and `actions` — what can be done now. " +
				"Asked of a standby, it says which main install it belongs to.",
			inputSchema: { instance_id: instanceId },
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ instance_id }) =>
			runTool(ctx.logger, "vomehome_chap_status", async () => jsonResult(await ctx.vomehome.chap(instance_id)))
	);

	server.registerTool(
		"vomehome_chap_standby_candidates",
		{
			title: "CHAP standby candidates",
			description:
				"The user's other house installs, connected to Vome and not in a pair, that could be this " +
				"home's standby. Use an id from here with vomehome_chap_link_standby.",
			inputSchema: { instance_id: instanceId },
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ instance_id }) =>
			runTool(ctx.logger, "vomehome_chap_standby_candidates", async () =>
				jsonResult(await ctx.vomehome.chap(instance_id, "standby-candidates"))
			)
	);

	const write = (
		name: string,
		title: string,
		description: string,
		path: string,
		method: string,
		schema: Record<string, z.ZodTypeAny>,
		body: (args: Record<string, unknown>) => unknown
	): void => {
		server.registerTool(
			name,
			{
				title,
				description,
				inputSchema: { instance_id: instanceId, ...schema },
				annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
			},
			async (args: Record<string, unknown>) =>
				runTool(ctx.logger, name, async () => {
					const id = String(args.instance_id);
					const refused = refuse(ctx, id);
					if (refused) return errorResult(refused);
					const result = await ctx.vomehome.chap(id, path, method, body(args));
					return result.ok === false ? errorResult(String(result.error ?? "Refused by VomeHome")) : jsonResult(result);
				})
		);
	};

	write(
		"vomehome_chap_enrol",
		"CHAP: turn on monitoring",
		"Turn on CHAP for an instance: heartbeats and outage alerts. Needed before a standby can be linked.",
		"enrol",
		"POST",
		{},
		() => ({})
	);

	write(
		"vomehome_chap_link_standby",
		"CHAP: link a standby",
		"Make another of the user's house installs this home's standby (for a home hosted by Vome: its " +
			"local fallback). Then call vomehome_chap_pair to pair both and fill the standby. The standby must " +
			"already be connected to Vome and running the Vome CHAP add-on.",
		"standby",
		"POST",
		{ install_id: z.string().describe("The install to use, from vomehome_chap_standby_candidates.") },
		(args) => ({ install_id: args.install_id })
	);

	write(
		"vomehome_chap_unlink_standby",
		"CHAP: stop using the standby",
		"Stop using the linked house standby or local fallback. Refused while it is running the home. Its " +
			"Home Assistant stays stopped until the user starts it.",
		"standby",
		"DELETE",
		{},
		() => undefined
	);

	write(
		"vomehome_chap_pair",
		"CHAP: pair both installs",
		"Pair both installs with Vome and fill the standby from a one-off backup of the main install, " +
			"then keep it in step. Takes a few minutes; follow it with vomehome_chap_status.",
		"pair",
		"POST",
		{},
		() => ({})
	);

	write(
		"vomehome_chap_switch",
		"CHAP: switch to the standby",
		"Move the home to the standby on purpose (for maintenance): the main install's latest changes go " +
			"across first, then the standby starts and the main install stops. Pass cancel=true to call off " +
			"a switch still waiting for the changes. Ask the user before switching a real home.",
		"switch",
		"POST",
		{ cancel: z.boolean().optional().describe("Call off a switch in progress instead.") },
		(args) => (args.cancel ? { cancel: true } : {})
	);

	write(
		"vomehome_chap_switch_back",
		"CHAP: switch back",
		"Move the home back to its main install. By default the standby's changes go back first; now=true " +
			"switches back at once and leaves anything changed on the standby since its last sync behind — " +
			"for emergencies only. A standby that was out of step when it took over is refused the sync " +
			"(it would put old settings over newer ones): use now=true then. Ask the user first.",
		"switch-back",
		"POST",
		{ now: z.boolean().optional().describe("Switch back without syncing first (emergency).") },
		(args) => (args.now ? { now: true } : {})
	);

	write(
		"vomehome_chap_set_takeover_rule",
		"CHAP: what an out-of-step standby does",
		"Choose what a standby that has stopped taking the main install's changes does when the home " +
			"needs it: rule=\"anyway\" (the default) takes over on its old settings, since they beat no " +
			"Home Assistant at all, and nothing it changes is synced back; rule=\"in_step\" waits until it is " +
			"back in step. vomehome_chap_status shows the rule (pair.takeover_when_out_of_step) and whether " +
			"the standby is out of step now (pair.out_of_step).",
		"takeover-rule",
		"POST",
		{ rule: z.enum(["anyway", "in_step"]).describe("anyway: take over on old settings; in_step: wait until in step.") },
		(args) => ({ rule: args.rule })
	);

	write(
		"vomehome_chap_set_home_address",
		"CHAP: the home's address at home",
		"Set the house-network address (e.g. 192.168.1.15/24) that follows whichever install runs the " +
			"home, so phones and dashboards need no change after a switch. address=null stops moving it.",
		"home-address",
		"POST",
		{ address: z.string().nullable().describe("An address on the house network, or null.") },
		(args) => ({ address: args.address ?? null })
	);

}

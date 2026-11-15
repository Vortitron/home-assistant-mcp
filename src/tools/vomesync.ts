import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { splitServiceResult } from "../ha/restClient.js";
import { evaluateDomainWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, toErrorMessage, type ToolContext } from "./helpers.js";

/**
 * VomeSync switches made and changed by an agent, on the home's own Vome
 * integration (vomesync.create_switch / vomesync.update_switch): the switch
 * is owned by that Home Assistant's key, exactly as if made in its UI.
 *
 * Making a switch public can need a CAPTCHA, which an agent can't solve. An
 * account paying for Vome doesn't need one: the portal hands its home a
 * single-use pass, and these tools fetch and send it themselves.
 */

const CATEGORIES = [
	"Community",
	"Personal",
	"Event",
	"Transport",
	"Government",
	"Holiday",
	"Weather",
	"IsUp",
	"Test",
	"Other"
] as const;

const fields = {
	description: z.string().max(500).optional().describe("What the switch means, shown to everyone who finds it."),
	location: z.string().max(100).optional().describe("Where it is, e.g. 'Skåne, Sweden'."),
	category: z.enum(CATEGORIES).optional().describe("Catalogue category (default Other)."),
	link: z.string().url().optional().describe("A page about the thing the switch stands for."),
	icon_url: z.string().url().optional().describe("Square image Vome copies as the icon."),
	banner_url: z.string().url().optional().describe("Wide image Vome copies as the banner."),
	publicize: z
		.boolean()
		.optional()
		.describe(
			"List it in the public catalogue so anyone can find and watch it (changing it stays private to the " +
				"owner and its access keys). Default false."
		)
};

type Fields = { [K in keyof typeof fields]?: z.infer<(typeof fields)[K]> };

const SERVICE_DATA_KEYS: (keyof Fields)[] = ["description", "location", "category", "link", "icon_url", "banner_url", "publicize"];

function serviceData(args: Fields & { name?: string }): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	if (args.name !== undefined) data.name = args.name;
	for (const key of SERVICE_DATA_KEYS) {
		if (args[key] !== undefined) data[key] = args[key];
	}
	return data;
}

interface PassOutcome {
	token?: string;
	note?: string;
}

/** A Vome pass for the active home, when this session reaches the portal. */
async function passFor(ctx: ToolContext): Promise<PassOutcome> {
	if (!ctx.vomehome.isEnabled()) {
		return { note: "Not connected through Vome, so no Vome pass: the sync server decides on its own." };
	}
	try {
		const minted = await ctx.vomehome.vomesyncPass(ctx.instances.activeId());
		if (minted.pass) return { token: minted.pass };
		return { note: minted.error ?? "No Vome pass for this account." };
	} catch (error) {
		return { note: `Could not get a Vome pass: ${toErrorMessage(error)}` };
	}
}

function explainRefusal(error: unknown, triedPass: PassOutcome): string {
	const message = toErrorMessage(error);
	if (/captcha/i.test(message)) {
		return (
			`VomeSync wants a CAPTCHA to make this switch public. ${triedPass.note ?? ""} ` +
			"An account with a Vome plan (or a package from Vome) skips it; otherwise make the switch without " +
			"publicize and ask the owner."
		).replace(/\s+/g, " ").trim();
	}
	if (/not found|unknown action|Action .* not found|Service .* not found/i.test(message)) {
		return `${message} The home's Vome integration may be too old: update it (Vome ≥ 0.9.68 has vomesync.update_switch).`;
	}
	return message;
}

export function registerVomeSyncTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"vomesync_create_switch",
		{
			title: "Create a VomeSync switch",
			description:
				"Create a VomeSync switch owned by this Home Assistant (its Vome integration): a shared on/off that " +
				"other homes can watch, with an optional note on each change. Returns its uid and the new " +
				"switch.* entity appears in Home Assistant. With publicize, a Vome plan's pass is fetched and sent " +
				"so no CAPTCHA is needed. To let a website or script change it, make an access key in the " +
				"integration's options (toggle permission).",
			inputSchema: {
				name: z.string().min(1).max(100).describe("The switch's name, e.g. 'Hancocks IT daily briefing'."),
				...fields
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
		},
		async (args) =>
			runTool(ctx.logger, "vomesync_create_switch", async () => {
				const decision = evaluateDomainWrite("vomesync", ctx.instances.currentSafety());
				if (!decision.allowed) return errorResult(`Refused: ${decision.reason}`);
				const data = serviceData(args);
				const pass: PassOutcome = args.publicize ? await passFor(ctx) : {};
				if (pass.token) data.captcha_token = pass.token;
				try {
					const { response } = splitServiceResult(
						await ctx.rest.callService("vomesync", "create_switch", data, undefined, { returnResponse: true })
					);
					const uid = (response as { uid?: unknown } | undefined)?.uid;
					return jsonResult({
						uid: typeof uid === "string" ? uid : undefined,
						name: args.name,
						public: Boolean(args.publicize),
						...(args.publicize ? { used_vome_pass: Boolean(pass.token) } : {}),
						...(pass.note && !pass.token ? { pass_note: pass.note } : {})
					});
				} catch (error) {
					return errorResult(explainRefusal(error, pass));
				}
			})
	);

	server.registerTool(
		"vomesync_update_switch",
		{
			title: "Change a VomeSync switch's details",
			description:
				"Change the name, description, link, images or category of a VomeSync switch this Home Assistant " +
				"owns, or make it public or private. Give only what changes. Making it public fetches and sends a " +
				"Vome plan's pass so no CAPTCHA is needed. Needs the home's Vome integration 0.9.68 or later.",
			inputSchema: {
				entity_id: z.string().regex(/^switch\./).describe("The switch.* entity of a VomeSync switch you own."),
				name: z.string().min(1).max(100).optional().describe("New name."),
				...fields
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
		},
		async (args) =>
			runTool(ctx.logger, "vomesync_update_switch", async () => {
				const decision = evaluateDomainWrite("vomesync", ctx.instances.currentSafety());
				if (!decision.allowed) return errorResult(`Refused: ${decision.reason}`);
				const data = serviceData(args);
				if (Object.keys(data).length === 0) {
					return errorResult("Give at least one detail to change.");
				}
				data.entity_id = args.entity_id;
				const pass: PassOutcome = args.publicize === true ? await passFor(ctx) : {};
				if (pass.token) data.captcha_token = pass.token;
				try {
					const { response } = splitServiceResult(
						await ctx.rest.callService("vomesync", "update_switch", data, undefined, { returnResponse: true })
					);
					return jsonResult({
						updated: args.entity_id,
						switch: response,
						...(args.publicize === true ? { used_vome_pass: Boolean(pass.token) } : {}),
						...(pass.note && !pass.token ? { pass_note: pass.note } : {})
					});
				} catch (error) {
					return errorResult(explainRefusal(error, pass));
				}
			})
	);
}

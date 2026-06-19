import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VomeHomeInstance } from "../vomehome/client.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Tools for the VomeHome portal: list a user's managed Home Assistant
 * instances, check their status, reboot them, create a throwaway test instance
 * and mint a one-click HA login URL. Reads are always allowed; reboot needs the
 * master write switch and create additionally needs VOMEHOME_ALLOW_CREATE.
 */

/** Drops undefined values so tool output stays compact and snake_cased. */
function serialiseInstance(instance: VomeHomeInstance): Record<string, unknown> {
	const out: Record<string, unknown> = { id: instance.id };
	if (instance.name !== undefined) out.name = instance.name;
	if (instance.status !== undefined) out.status = instance.status;
	if (instance.tier !== undefined) out.tier = instance.tier;
	if (instance.haUrl !== undefined) out.ha_url = instance.haUrl;
	if (instance.customDomain !== undefined) out.custom_domain = instance.customDomain;
	if (instance.createdAt !== undefined) out.created_at = instance.createdAt;
	if (instance.live !== undefined) {
		const live: Record<string, unknown> = {};
		if (instance.live.reachable !== undefined) live.reachable = instance.live.reachable;
		if (instance.live.haState !== undefined) live.ha_state = instance.live.haState;
		if (instance.live.haHealth !== undefined) live.ha_health = instance.live.haHealth;
		out.live = live;
	}
	return out;
}

export function registerVomeHomeTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"vomehome_list_instances",
		{
			title: "List VomeHome instances",
			description:
				"List the Home Assistant instances on your VomeHome account, with status, tier, HA URL and (where available) live health. Requires VOMEHOME_TOKEN.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "vomehome_list_instances", async () => {
				const instances = await ctx.vomehome.listInstances();
				const active = ctx.instances.activeId();
				return jsonResult({
					count: instances.length,
					active_instance: active,
					note: "client_access shows the MCP's per-instance write/config flags (from VOMEHOME_INSTANCES, the default instance, or auto-granted on create). The server-side token scopes still apply on top.",
					instances: instances.map((instance) => {
						const access = ctx.instances.access(instance.id);
						return {
							...serialiseInstance(instance),
							active: instance.id === active,
							client_access: {
								write: access.write,
								config: access.config,
								declared: ctx.instances.has(instance.id)
							}
						};
					})
				});
			})
	);

	server.registerTool(
		"vomehome_use_instance",
		{
			title: "Switch active VomeHome instance",
			description:
				"Switch which VomeHome instance the Home Assistant tools target. Subsequent ha_* calls (states, services, automations, templates, check_config) operate on this instance, and write/config permission follows that instance's own flags (declared in VOMEHOME_INSTANCES, the default instance, or auto-granted on create). An undeclared but reachable instance becomes read-only here.",
			inputSchema: {
				instance_id: z
					.string()
					.describe("VomeHome instance id to make active, as returned by vomehome_list_instances.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ instance_id }) =>
			runTool(ctx.logger, "vomehome_use_instance", async () => {
				if (!ctx.instances.brokered) {
					return errorResult(
						"Refused: a single direct Home Assistant is configured (HA_URL/HA_TOKEN), so there is no instance to switch. Multi-instance applies only in brokered VomeHome mode."
					);
				}
				const target = ctx.instances.use(instance_id);
				return jsonResult({
					active_instance: target.id,
					declared: target.inRegistry,
					client_access: { write: target.access.write, config: target.access.config },
					note: target.inRegistry
						? "Active instance switched. Home Assistant tools now target this instance."
						: "Active instance switched, but this instance is not declared in VOMEHOME_INSTANCES so it is read-only here. Add it (with write/config) to enable changes."
				});
			})
	);

	server.registerTool(
		"vomehome_get_instance",
		{
			title: "Get VomeHome instance",
			description:
				"Get one VomeHome instance by id, including live status and the Home Assistant URL. Requires VOMEHOME_TOKEN.",
			inputSchema: {
				instance_id: z.string().describe("VomeHome instance id (UUID), as returned by vomehome_list_instances.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ instance_id }) =>
			runTool(ctx.logger, "vomehome_get_instance", async () => {
				const instance = await ctx.vomehome.getInstance(instance_id);
				return jsonResult(serialiseInstance(instance));
			})
	);

	server.registerTool(
		"vomehome_reboot_instance",
		{
			title: "Reboot VomeHome instance",
			description:
				"Reboot a VomeHome Home Assistant instance (reboots the underlying VM). Requires HA_ALLOW_WRITE=true (the master write switch).",
			inputSchema: {
				instance_id: z.string().describe("VomeHome instance id (UUID) to reboot.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ instance_id }) =>
			runTool(ctx.logger, "vomehome_reboot_instance", async () => {
				if (!ctx.config.safety.allowWrite) {
					return errorResult(
						"Refused: rebooting an instance requires HA_ALLOW_WRITE=true (the master write switch)."
					);
				}
				const result = await ctx.vomehome.restartInstance(instance_id);
				return jsonResult({
					instance_id,
					rebooting: result.success,
					message: result.message ?? "Reboot requested."
				});
			})
	);

	server.registerTool(
		"vomehome_create_instance",
		{
			title: "Create VomeHome instance",
			description:
				"Create a new Home Assistant instance on VomeHome — useful for spinning up a throwaway test/sandbox install. This is a heavyweight action: it requires both HA_ALLOW_WRITE=true and VOMEHOME_ALLOW_CREATE=true (account-wide), and may be subject to your account's instance limit and billing. The new instance is granted full write + config access automatically and becomes the active target.",
			inputSchema: {
				name: z.string().min(1).describe("Human-friendly name for the new instance."),
				timezone: z
					.string()
					.optional()
					.describe("Optional IANA time zone, e.g. 'Europe/London'.")
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
		},
		async ({ name, timezone }) =>
			runTool(ctx.logger, "vomehome_create_instance", async () => {
				if (!ctx.config.safety.allowWrite) {
					return errorResult(
						"Refused: creating an instance requires HA_ALLOW_WRITE=true (the master write switch)."
					);
				}
				if (!ctx.config.vomehome.allowCreate) {
					return errorResult(
						"Refused: creating an instance also requires VOMEHOME_ALLOW_CREATE=true (an extra guard for this heavyweight action)."
					);
				}
				const instance = await ctx.vomehome.createInstance({ name, timezone });
				const access = ctx.instances.registerCreated(instance.id, name);
				return jsonResult({
					created: true,
					instance: serialiseInstance(instance),
					active_instance: ctx.instances.activeId(),
					client_access: { write: access.write, config: access.config },
					note: "You created this instance, so it now has full write + config access and is the active target — HA tools operate on it until you switch (vomehome_use_instance). To keep this access across MCP restarts, add the id to VOMEHOME_INSTANCES."
				});
			})
	);

	server.registerTool(
		"vomehome_get_login_url",
		{
			title: "Get VomeHome one-click login URL",
			description:
				"Get a one-click login URL that opens your VomeHome Home Assistant already signed in. Present the returned URL to the user as a link to open in a new browser tab/window. The URL embeds a short-lived credential, so treat it as a secret and do not log it. Requires VOMEHOME_TOKEN.",
			inputSchema: {
				instance_id: z.string().describe("VomeHome instance id (UUID) to open.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ instance_id }) =>
			runTool(ctx.logger, "vomehome_get_login_url", async () => {
				const login = await ctx.vomehome.getLoginUrl(instance_id);
				return jsonResult({
					instance_id,
					login_url: login.url,
					expires_at: login.expiresAt,
					note: "Open this URL in a new browser tab/window to sign in. It contains a short-lived credential — do not share it."
				});
			})
	);
}

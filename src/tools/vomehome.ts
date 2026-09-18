import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import type { GuestLinkSummary, VomeHomeInstance } from "../vomehome/client.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Tools for the VomeHome portal: list a user's managed Home Assistant
 * instances, check their status, reboot them, create a throwaway test instance
 * and mint a one-click HA login URL. Reads are always allowed; mutating actions
 * defer to the API key's scopes in brokered mode (optional local env guards only).
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

function serialiseGuestLink(link: GuestLinkSummary): Record<string, unknown> {
	const out: Record<string, unknown> = { id: link.id, admin: link.admin };
	if (link.dashboard !== undefined) out.dashboard = link.dashboard;
	if (link.createdAt !== undefined) out.created_at = link.createdAt;
	if (link.expiresAt !== undefined) out.expires_at = link.expiresAt;
	if (link.revokedAt !== undefined) out.revoked_at = link.revokedAt;
	return out;
}

function refuseGuestLinkWrite(ctx: ToolContext, instanceId: string): string {
	return ctx.instances.brokered
		? `Refused: guest links are blocked locally for '${instanceId}' ` +
				"(write/config false in VOMEHOME_INSTANCES). Otherwise the API key decides."
		: "Refused: guest links need HA_ALLOW_WRITE and HA_ALLOW_CONFIG_WRITE in direct mode.";
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
				"Switch which VomeHome instance the Home Assistant tools target. Subsequent ha_* calls (states, services, automations, templates, check_config) operate on this instance, and write/config permission follows that instance's own flags (declared in VOMEHOME_INSTANCES, the default instance, or auto-granted on create). An undeclared but reachable instance inherits the global default, which in brokered mode defers to the API key's server-side scopes.",
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
						: "Active instance switched. This instance is not declared in VOMEHOME_INSTANCES, so it inherits the global default shown in client_access; the API key's scopes for it still apply server-side."
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
				"Reboot a VomeHome Home Assistant instance (reboots the underlying VM). In brokered mode the API key's ha:write (or instances:write) scope is authoritative; an optional local VOMEHOME_INSTANCES write:false only adds a client-side block.",
			inputSchema: {
				instance_id: z.string().describe("VomeHome instance id (UUID) to reboot.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ instance_id }) =>
			runTool(ctx.logger, "vomehome_reboot_instance", async () => {
				// Rebooting is a state change on THAT instance, so it needs write
				// access for that specific instance — not just the global switch.
				if (!ctx.instances.safetyFor(instance_id).allowWrite) {
					return errorResult(
						ctx.instances.brokered
							? `Refused: rebooting '${instance_id}' is blocked locally ` +
								"(this instance is marked write:false in VOMEHOME_INSTANCES). " +
								"Otherwise the API key's scopes decide — check the portal."
							: "Refused: rebooting an instance requires HA_ALLOW_WRITE=true (direct-mode master write switch)."
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
				"Create a new Home Assistant instance on VomeHome — useful for spinning up a throwaway test/sandbox install. In brokered mode the API key's create scope is authoritative (no local env flags required). Optionally set VOMEHOME_ALLOW_CREATE=false to block creation locally. The creating API key is granted full Home Assistant access on the new instance (ha:read, ha:write, ha:config, ha:files) and it becomes the active target.",
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
				// Account-wide create: only honour an explicit local opt-out.
				// In brokered mode the default is permissive; the portal enforces
				// the key's create scope. Do not also require HA_ALLOW_WRITE.
				if (!ctx.config.vomehome.allowCreate) {
					return errorResult(
						ctx.config.brokered
							? "Refused: creating instances is disabled locally (VOMEHOME_ALLOW_CREATE=false). " +
								"Remove that env var to defer to your API key's create scope."
							: "Refused: creating an instance requires VOMEHOME_ALLOW_CREATE=true in direct mode, " +
								"or use brokered VomeHome auth (token + instance id, no HA_TOKEN) where the key decides."
					);
				}
				const instance = await ctx.vomehome.createInstance({ name, timezone });
				const access = ctx.instances.registerCreated(instance.id, name);
				const granted = instance.grantedScopes;
				return jsonResult({
					created: true,
					instance: serialiseInstance(instance),
					active_instance: ctx.instances.activeId(),
					client_access: { write: access.write, config: access.config },
					server_access: granted ?? null,
					note:
						"You created this instance, so this API key now has full Home Assistant access on it " +
						"(ha:read, ha:write, ha:config, ha:files) and it is the active target — HA tools operate " +
						"on it until you switch (vomehome_use_instance). Other keys on the account are unchanged. " +
						"To keep this instance known across MCP restarts, add the id to VOMEHOME_INSTANCES " +
						"(or a dedicated mcp.json server entry)."
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

	server.registerTool(
		"vomehome_create_guest_link",
		{
			title: "Create a guest link",
			description:
				"Create a non-admin (unless admin=true) Home Assistant user for this instance, plus a " +
				"one-click login URL for it — self-serve, revocable sharing without handing out the " +
				"owner's own login. Only works for Vome-hosted instances (not self-hosted/relay ones): " +
				"minting a token for someone other than the owner needs direct network access to the VM.\n\n" +
				"**Home Assistant's permission model is coarse.** A non-admin guest is locked out of " +
				"Settings and Developer Tools, but can still call services on any entity the dashboard " +
				"shows them — there is no per-entity guest scoping in Home Assistant itself. This is safe " +
				"on a dedicated demo/sandbox instance built to be poked at. It is not a substitute for " +
				"real access control on somebody's actual house — do not point a guest link at one.\n\n" +
				"The link expires automatically (default 24h, max 30 days) and can be revoked early with " +
				"vomehome_revoke_guest_link. Treat the returned URL as a secret; do not log it.",
			inputSchema: {
				instance_id: z.string().describe("VomeHome instance id (UUID) to create the guest user on."),
				admin: z
					.boolean()
					.optional()
					.describe("Grant full admin access instead of a restricted account. Default false — choose true deliberately."),
				dashboard: z
					.string()
					.optional()
					.describe("Lovelace url_path to land the guest on after sign-in, instead of the default dashboard."),
				expires_in: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Seconds until this link is auto-revoked. Default 24h (86400), capped at 30 days.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ instance_id, admin, dashboard, expires_in }) =>
			runTool(ctx.logger, "vomehome_create_guest_link", async () => {
				const decision = evaluateConfigWrite(ctx.instances.safetyFor(instance_id));
				if (!decision.allowed) {
					return errorResult(refuseGuestLinkWrite(ctx, instance_id));
				}
				const link = await ctx.vomehome.createGuestLink(instance_id, {
					admin,
					dashboard,
					expiresIn: expires_in
				});
				return jsonResult({
					instance_id,
					id: link.id,
					url: link.url,
					expires_at: link.expiresAt,
					note:
						"Share this URL with the guest — it signs them straight in as a " +
						(admin ? "full-admin" : "non-admin") +
						" user. Revoke early with vomehome_revoke_guest_link if needed."
				});
			})
	);

	server.registerTool(
		"vomehome_list_guest_links",
		{
			title: "List guest links",
			description:
				"List guest links created for this instance, including already-revoked ones (with " +
				"revoked_at set). Never returns the login URL again — only enough to identify and " +
				"manage each link.",
			inputSchema: {
				instance_id: z.string().describe("VomeHome instance id (UUID).")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ instance_id }) =>
			runTool(ctx.logger, "vomehome_list_guest_links", async () => {
				const links = await ctx.vomehome.listGuestLinks(instance_id);
				return jsonResult({
					instance_id,
					count: links.length,
					guest_links: links.map(serialiseGuestLink)
				});
			})
	);

	server.registerTool(
		"vomehome_revoke_guest_link",
		{
			title: "Revoke a guest link",
			description:
				"Revoke a guest link immediately: deletes its Home Assistant user, which invalidates " +
				"every credential and token attached to it in one step. Safe to call on an already-" +
				"revoked link (no-op).",
			inputSchema: {
				instance_id: z.string().describe("VomeHome instance id (UUID)."),
				link_id: z.string().describe("Guest link id, from vomehome_create_guest_link or vomehome_list_guest_links.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ instance_id, link_id }) =>
			runTool(ctx.logger, "vomehome_revoke_guest_link", async () => {
				const decision = evaluateConfigWrite(ctx.instances.safetyFor(instance_id));
				if (!decision.allowed) {
					return errorResult(refuseGuestLinkWrite(ctx, instance_id));
				}
				await ctx.vomehome.revokeGuestLink(instance_id, link_id);
				return jsonResult({ instance_id, link_id, revoked: true });
			})
	);
}

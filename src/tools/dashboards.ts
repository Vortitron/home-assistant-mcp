import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/** Send a Lovelace WebSocket command (direct WS or VomeHome broker). */
async function lovelaceCommand<T>(
	ctx: ToolContext,
	command: Record<string, unknown>
): Promise<T> {
	return ctx.rest.sendWsCommand<T>(command);
}

export function registerDashboardTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_dashboards",
		{
			title: "List Lovelace dashboards",
			description:
				"List Home Assistant Lovelace dashboards (url_path, title, mode, sidebar visibility). Works in direct HA mode and VomeHome brokered mode.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_list_dashboards", async () => {
				const dashboards = await lovelaceCommand<unknown[]>(ctx, {
					type: "lovelace/dashboards/list"
				});
				const rows = Array.isArray(dashboards) ? dashboards : [];
				return jsonResult({ count: rows.length, dashboards: rows });
			})
	);

	server.registerTool(
		"ha_get_dashboard",
		{
			title: "Get Lovelace dashboard config",
			description:
				"Get the full Lovelace configuration for one dashboard (views, cards, etc.). Use url_path from ha_list_dashboards — e.g. 'lovelace' for the default overview, or a custom path like 'sam-energy'.",
			inputSchema: {
				url_path: z
					.string()
					.describe(
						"Dashboard url_path (from ha_list_dashboards). Omit or use 'lovelace' for the default overview."
					)
					.optional()
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ url_path }) =>
			runTool(ctx.logger, "ha_get_dashboard", async () => {
				const command: Record<string, unknown> = { type: "lovelace/config" };
				if (url_path !== undefined && url_path !== "") {
					command.url_path = url_path;
				}
				const config = await lovelaceCommand<Record<string, unknown>>(ctx, command);
				return jsonResult({ url_path: url_path ?? "lovelace", config });
			})
	);

	server.registerTool(
		"ha_save_dashboard",
		{
			title: "Save Lovelace dashboard config",
			description:
				"Save (create or replace) the Lovelace configuration for a dashboard. 'config' is the dashboard body (title, views, …). Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true.",
			inputSchema: {
				url_path: z
					.string()
					.describe("Dashboard url_path to save (must already exist, or create it first with ha_create_dashboard)."),
				config: z
					.record(z.string(), z.unknown())
					.describe("Lovelace dashboard configuration object (title, views, cards, …).")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ url_path, config }) =>
			runTool(ctx.logger, "ha_save_dashboard", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(decision.reason);
				}
				await lovelaceCommand(ctx, {
					type: "lovelace/config/save",
					url_path,
					config
				});
				return jsonResult({
					saved: true,
					url_path,
					hint: `Verify with ha_get_dashboard on '${url_path}'.`
				});
			})
	);

	server.registerTool(
		"ha_create_dashboard",
		{
			title: "Create Lovelace dashboard",
			description:
				"Register a new storage-mode Lovelace dashboard. After creating, call ha_save_dashboard to set its views/cards. Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true.",
			inputSchema: {
				url_path: z.string().describe("URL path slug for the new dashboard (e.g. 'sam-energy')."),
				title: z.string().describe("Sidebar title for the dashboard."),
				show_in_sidebar: z
					.boolean()
					.optional()
					.describe("Show in the sidebar (default true)."),
				icon: z.string().optional().describe("MDI icon for the sidebar (e.g. 'mdi:home')."),
				require_admin: z
					.boolean()
					.optional()
					.describe("Restrict dashboard to admin users (default false)."),
				allow_single_word: z
					.boolean()
					.optional()
					.describe("Allow a url_path without a hyphen (default false).")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ url_path, title, show_in_sidebar, icon, require_admin, allow_single_word }) =>
			runTool(ctx.logger, "ha_create_dashboard", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(decision.reason);
				}
				const body: Record<string, unknown> = {
					type: "lovelace/dashboards/create",
					url_path,
					title,
					mode: "storage",
					show_in_sidebar: show_in_sidebar ?? true,
					require_admin: require_admin ?? false
				};
				if (icon) {
					body.icon = icon;
				}
				if (allow_single_word) {
					body.allow_single_word = true;
				}
				const created = await lovelaceCommand<Record<string, unknown>>(ctx, body);
				return jsonResult({
					created: true,
					url_path,
					dashboard: created,
					hint: "Call ha_save_dashboard next to set views and cards."
				});
			})
	);

	server.registerTool(
		"ha_delete_dashboard",
		{
			title: "Delete Lovelace dashboard",
			description:
				"Delete a storage-mode Lovelace dashboard by its id (from ha_list_dashboards or ha_create_dashboard). Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true.",
			inputSchema: {
				dashboard_id: z.string().describe("Dashboard id to delete (not url_path).")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ dashboard_id }) =>
			runTool(ctx.logger, "ha_delete_dashboard", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(decision.reason);
				}
				await lovelaceCommand(ctx, {
					type: "lovelace/dashboards/delete",
					dashboard_id
				});
				return jsonResult({ deleted: true, dashboard_id });
			})
	);
}

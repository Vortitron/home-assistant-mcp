import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Backups Home Assistant keeps in its "Vome" backup location, through the
 * portal's JSON API (`/api/v1/instances/<id>/backups`).
 *
 * A backup runs to gigabytes, far more than a tool reply should carry, so the
 * download is a link: the portal mints one that works for a few minutes and
 * streams the file itself. The agent hands it to the user, or fetches it with
 * curl where it has a shell. A backup holds the home's secrets, so both tools
 * need the ha:files scope, the same as reading secrets.yaml.
 */

const instanceId = z.string().describe("VomeHome instance id (from vomehome_list_instances).");

export function registerVomeHomeBackupTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"vomehome_list_backups",
		{
			title: "List backups",
			description:
				"List the Home Assistant backups held in the home's Vome backup location (newest first): " +
				"id, name, date, size and whether it is password-protected. Requires the ha:files scope.",
			inputSchema: { instance_id: instanceId },
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ instance_id }) =>
			runTool(ctx.logger, "vomehome_list_backups", async () => jsonResult(await ctx.vomehome.backups(instance_id)))
	);

	server.registerTool(
		"vomehome_backup_download_link",
		{
			title: "Get a backup download link",
			description:
				"Make a short-lived link (about 15 minutes) that downloads one backup's .tar from the Vome " +
				"backup location. Give it to the user, or fetch it with curl -o. Anyone holding the link " +
				"can download the backup until it expires, so don't post it anywhere public. A protected " +
				"backup still needs its password to restore. Requires the ha:files scope.",
			inputSchema: {
				instance_id: instanceId,
				backup_id: z.string().min(1).describe("Backup id from vomehome_list_backups.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ instance_id, backup_id }) =>
			runTool(ctx.logger, "vomehome_backup_download_link", async () =>
				jsonResult(await ctx.vomehome.backups(instance_id, `${encodeURIComponent(backup_id)}/download-link`, "POST"))
			)
	);
}

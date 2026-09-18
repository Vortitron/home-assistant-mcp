import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * HACS (Home Assistant Community Store) repository management, over HACS's
 * own WebSocket commands (`hacs/*`) — there is no REST API and no supported
 * service call for adding a custom repository or installing it.
 *
 * These commands were already reachable through the generic WS passthrough
 * (`ha_supervisor_api`'s sibling, the broker's `/ha/ws/command`), but nothing
 * exposed them as a tool, and the portal's scope inference did not recognise
 * HACS's verbs ("add", "download", "state", "beta", "ignore") as writes —
 * see the fix in `portal/ha_ws_command.py`. Installing a custom repository
 * runs arbitrary code from GitHub inside the home, so every mutating tool
 * here is gated the same way as `ha_addon_install_vome`: local write+config
 * guard, then the API key's ha:config scope has the final say server-side.
 *
 * `hacs/repositories/add` reports success even when the add silently failed
 * (HACS dispatches an error *event* instead of a WS error) — the add tool
 * confirms by re-listing and matching on `full_name` rather than trusting
 * the empty `{}` result.
 */

interface HacsRepositoryRow {
	id: string;
	full_name: string;
	category: string;
	installed: boolean;
	name?: string;
	[key: string]: unknown;
}

async function hacsCommand<T>(ctx: ToolContext, command: Record<string, unknown>): Promise<T> {
	return ctx.ws.sendCommand<T>(command);
}

async function listRepositories(ctx: ToolContext, categories?: string[]): Promise<HacsRepositoryRow[]> {
	const command: Record<string, unknown> = { type: "hacs/repositories/list" };
	if (categories && categories.length > 0) {
		command.categories = categories;
	}
	const result = await hacsCommand<unknown>(ctx, command);
	return Array.isArray(result) ? (result as HacsRepositoryRow[]) : [];
}

/** Resolve a caller-supplied repository reference (an id or "owner/repo") to its row. */
async function resolveRepository(ctx: ToolContext, ref: string): Promise<HacsRepositoryRow | null> {
	const repositories = await listRepositories(ctx);
	const needle = ref.trim().toLowerCase();
	return (
		repositories.find(
			(row) => String(row.id) === ref.trim() || (row.full_name ?? "").toLowerCase() === needle
		) ?? null
	);
}

function refuseWrite(ctx: ToolContext): string {
	return ctx.instances.brokered
		? "Refused: HACS repository changes are blocked locally for this instance " +
				"(write/config false in VOMEHOME_INSTANCES). Otherwise the API key decides."
		: "Refused: HACS repository changes need HA_ALLOW_WRITE and HA_ALLOW_CONFIG_WRITE in direct mode.";
}

export function registerHacsTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_hacs_info",
		{
			title: "HACS status",
			description:
				"Whether HACS is installed and its version, configured country, and whether it has pending " +
				"background tasks. Returns an error if HACS is not installed on this instance.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_hacs_info", async () => {
				const info = await hacsCommand(ctx, { type: "hacs/info" });
				return jsonResult(info);
			})
	);

	server.registerTool(
		"ha_hacs_list_repositories",
		{
			title: "List HACS repositories",
			description:
				"List repositories HACS knows about — both custom and default-store ones it has fetched " +
				"metadata for. Each row includes id, full_name, category, installed, and whether it's custom. " +
				"Use this to find a repository's id before calling ha_hacs_download_repository or " +
				"ha_hacs_remove_repository.",
			inputSchema: {
				categories: z
					.array(z.string())
					.optional()
					.describe("Filter to these HACS categories (e.g. ['integration']). Omit for all.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ categories }) =>
			runTool(ctx.logger, "ha_hacs_list_repositories", async () => {
				const repositories = await listRepositories(ctx, categories);
				return jsonResult({ count: repositories.length, repositories });
			})
	);

	server.registerTool(
		"ha_hacs_add_repository",
		{
			title: "Add a custom HACS repository",
			description:
				"Add a custom repository to HACS by GitHub 'owner/repo' (or its URL) and category " +
				"(e.g. 'integration', 'plugin', 'theme', 'python_script', 'appdaemon', 'netdaemon', " +
				"'template'). This only registers it with HACS — call ha_hacs_download_repository " +
				"afterwards to actually install it. Requires ha:config: this is how a repository " +
				"HACS doesn't already list (a fork, a private project, one not yet in the default " +
				"store) becomes installable at all.\n\n" +
				"HACS reports success on this call even when the add silently failed, so this tool " +
				"confirms by re-listing repositories and checking the new one actually appears.",
			inputSchema: {
				repository: z.string().describe("GitHub 'owner/repo' or its URL, e.g. 'me/my-integration'."),
				category: z
					.string()
					.describe("HACS category: integration, plugin, theme, python_script, appdaemon, netdaemon, or template.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ repository, category }) =>
			runTool(ctx.logger, "ha_hacs_add_repository", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(refuseWrite(ctx));
				}
				const existing = await resolveRepository(ctx, repository);
				if (existing) {
					return jsonResult({
						added: false,
						already_tracked: true,
						repository: existing,
						next: existing.installed
							? "Already installed."
							: `Call ha_hacs_download_repository with repository_id '${existing.id}' to install it.`
					});
				}
				await hacsCommand(ctx, {
					type: "hacs/repositories/add",
					repository,
					category: category.toLowerCase()
				});
				// HACS clones and indexes the repo asynchronously; give it a moment
				// before checking whether the add actually took.
				await new Promise((resolve) => setTimeout(resolve, 2000));
				const added = await resolveRepository(ctx, repository);
				if (!added) {
					return errorResult(
						`HACS did not accept '${repository}' as a ${category} repository. Common causes: ` +
							"the category doesn't match what's in hacs.json on the default branch, the repo " +
							"lacks a valid manifest for that category, or it's already in the default store " +
							"under a different id."
					);
				}
				return jsonResult({
					added: true,
					repository: added,
					next: `Call ha_hacs_download_repository with repository_id '${added.id}' to install it.`
				});
			})
	);

	server.registerTool(
		"ha_hacs_download_repository",
		{
			title: "Install (download) a HACS repository",
			description:
				"Install or update a repository HACS already knows about — this is the step that " +
				"actually writes its files into the config directory and, for a brand-new integration, " +
				"reloads HACS's entities. Accepts either the repository id (from ha_hacs_list_repositories " +
				"or ha_hacs_add_repository) or its 'owner/repo' full name. A newly installed custom " +
				"integration or add-on domain still needs a Home Assistant restart before it can be set " +
				"up; a plugin/theme/dashboard resource does not. Requires ha:config.",
			inputSchema: {
				repository: z.string().describe("Repository id or 'owner/repo' full name."),
				version: z.string().optional().describe("Specific version/tag to install. Omit for the latest.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ repository, version }) =>
			runTool(ctx.logger, "ha_hacs_download_repository", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(refuseWrite(ctx));
				}
				const row = await resolveRepository(ctx, repository);
				if (!row) {
					return errorResult(
						`No HACS repository matches '${repository}'. Add it first with ha_hacs_add_repository, ` +
							"or check ha_hacs_list_repositories for the right id/full_name."
					);
				}
				const command: Record<string, unknown> = { type: "hacs/repository/download", repository: row.id };
				if (version) {
					command.version = version;
				}
				await hacsCommand(ctx, command);
				const after = await resolveRepository(ctx, row.id);
				return jsonResult({
					installed: true,
					repository: after ?? row,
					next: "If this is a new integration or add-on domain, restart Home Assistant before setting it up."
				});
			})
	);

	server.registerTool(
		"ha_hacs_remove_repository",
		{
			title: "Remove a HACS repository",
			description:
				"Uninstall a HACS-managed repository's files and stop HACS tracking it as custom. " +
				"Accepts either the repository id or its 'owner/repo' full name. Safe to call on a " +
				"repository that was never installed (it just stops tracking it). Requires ha:config.",
			inputSchema: {
				repository: z.string().describe("Repository id or 'owner/repo' full name.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ repository }) =>
			runTool(ctx.logger, "ha_hacs_remove_repository", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(refuseWrite(ctx));
				}
				const row = await resolveRepository(ctx, repository);
				if (!row) {
					return errorResult(`No HACS repository matches '${repository}'.`);
				}
				if (row.installed) {
					await hacsCommand(ctx, { type: "hacs/repository/remove", repository: row.id });
				}
				await hacsCommand(ctx, { type: "hacs/repositories/remove", repository: row.id });
				return jsonResult({ removed: true, repository: row });
			})
	);
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * The community store: HACS, or from Home Assistant 2026.11 the Marketplace
 * that replaced it in Core. Both are driven over their own WebSocket
 * commands (`hacs/*`, `marketplace/*`) -- there is no REST API and no
 * supported service call for adding a custom repository or installing it.
 * Each call asks `marketplace/info` first and falls back to HACS when Home
 * Assistant doesn't know the command, so the same tools work either side of
 * the upgrade. The tool names keep saying "hacs": clients already use them.
 *
 * Installing a repository runs code from GitHub inside the home, so every
 * mutating tool here is gated the same way as `ha_addon_install_vome`: local
 * write+config guard, then the API key's ha:config scope has the final say
 * server-side (`portal/ha_ws_command.py` classifies both prefixes).
 *
 * The Marketplace also asks the home's admin two things itself: to accept
 * its warning about community code before anything installs, and to connect
 * GitHub before a repository outside its catalogue can be added. Those are
 * the owner's decisions, so these tools explain them rather than make them
 * (there is no tool for `marketplace/warning/accept`).
 *
 * `hacs/repositories/add` reports success even when the add silently failed
 * (HACS dispatches an error *event* instead of a WS error) -- the add tool
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

type Store = "marketplace" | "hacs";

const COMMANDS: Record<Store, Record<"info" | "list" | "add" | "install" | "uninstall" | "untrack", string>> = {
	marketplace: {
		info: "marketplace/info",
		list: "marketplace/repositories/list",
		add: "marketplace/repositories/add",
		install: "marketplace/repository/install",
		uninstall: "marketplace/repository/uninstall",
		untrack: "marketplace/repositories/remove"
	},
	hacs: {
		info: "hacs/info",
		list: "hacs/repositories/list",
		add: "hacs/repositories/add",
		install: "hacs/repository/download",
		uninstall: "hacs/repository/remove",
		untrack: "hacs/repositories/remove"
	}
};

const STORE_NAME: Record<Store, string> = { marketplace: "the Marketplace", hacs: "HACS" };

// What the Marketplace answers with a code, said so the agent can tell the
// owner what to do instead of retrying.
const MARKETPLACE_ERRORS: Array<[RegExp, string]> = [
	[
		/warning_not_accepted/,
		"Nothing can be installed until an admin opens Settings → Marketplace in Home Assistant and accepts " +
			"its warning about community code. That is the owner's decision; ask them to do it, then try again."
	],
	[
		/github_not_connected/,
		"Adding a repository that isn't in the Marketplace's catalogue needs a GitHub account connected in " +
			"Settings → Marketplace (the admin does this once). Catalogue repositories install without it."
	],
	[
		/replaces_built_in/,
		"This repository replaces an integration built into Home Assistant. Install it from Settings → " +
			"Marketplace, where the admin confirms that, rather than through this tool."
	],
	[/github_rate_limited/, "GitHub's rate limit was hit. Try again later, or connect GitHub in Settings → Marketplace."],
	[/not_loaded/, "The Marketplace isn't running on this Home Assistant (disabled, or still starting)."]
];

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isUnknownCommand(error: unknown): boolean {
	return /unknown_command|unknown command/i.test(errorText(error));
}

function explain(error: unknown): Error {
	const text = errorText(error);
	for (const [pattern, message] of MARKETPLACE_ERRORS) {
		if (pattern.test(text)) {
			return new Error(`${message} (${text})`);
		}
	}
	return error instanceof Error ? error : new Error(text);
}

interface StoreSession {
	store: Store;
	info: unknown;
	send<T>(verb: keyof (typeof COMMANDS)["hacs"], params?: Record<string, unknown>): Promise<T>;
}

/** Find out which store this Home Assistant has: the Marketplace (2026.11+) or HACS. */
async function openStore(ctx: ToolContext): Promise<StoreSession> {
	const session = (store: Store, info: unknown): StoreSession => ({
		store,
		info,
		send: async <T>(verb: keyof (typeof COMMANDS)["hacs"], params: Record<string, unknown> = {}) => {
			try {
				return await ctx.ws.sendCommand<T>({ type: COMMANDS[store][verb], ...params });
			} catch (error) {
				throw store === "marketplace" ? explain(error) : error;
			}
		}
	});
	try {
		return session("marketplace", await ctx.ws.sendCommand({ type: COMMANDS.marketplace.info }));
	} catch (error) {
		if (!isUnknownCommand(error)) {
			throw explain(error);
		}
	}
	return session("hacs", await ctx.ws.sendCommand({ type: COMMANDS.hacs.info }));
}

async function listRepositories(store: StoreSession, categories?: string[]): Promise<HacsRepositoryRow[]> {
	const params: Record<string, unknown> = {};
	if (categories && categories.length > 0) {
		params.categories = categories;
	}
	const result = await store.send<unknown>("list", params);
	return Array.isArray(result) ? (result as HacsRepositoryRow[]) : [];
}

/** Resolve a caller-supplied repository reference (an id or "owner/repo") to its row. */
async function resolveRepository(store: StoreSession, ref: string): Promise<HacsRepositoryRow | null> {
	const repositories = await listRepositories(store);
	const needle = ref.trim().toLowerCase();
	return (
		repositories.find(
			(row) => String(row.id) === ref.trim() || (row.full_name ?? "").toLowerCase() === needle
		) ?? null
	);
}

function refuseWrite(ctx: ToolContext): string {
	return ctx.instances.brokered
		? "Refused: community store changes are blocked locally for this instance " +
				"(write/config false in VOMEHOME_INSTANCES). Otherwise the API key decides."
		: "Refused: community store changes need HA_ALLOW_WRITE and HA_ALLOW_CONFIG_WRITE in direct mode.";
}

export function registerHacsTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_hacs_info",
		{
			title: "Community store status",
			description:
				"Which community store this Home Assistant has -- the built-in Marketplace (2026.11 and later) " +
				"or HACS -- and its status: version, whether it has pending background tasks, and for the " +
				"Marketplace whether GitHub is connected and whether the admin has accepted its warning " +
				"(nothing installs until they have). Returns an error if neither is installed.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_hacs_info", async () => {
				const store = await openStore(ctx);
				const info = store.info && typeof store.info === "object" ? store.info : { info: store.info };
				return jsonResult({ store: store.store, ...(info as Record<string, unknown>) });
			})
	);

	server.registerTool(
		"ha_hacs_list_repositories",
		{
			title: "List community store repositories",
			description:
				"List repositories the community store (the Marketplace, or HACS before 2026.11) knows about — " +
				"both custom and catalogue ones it has fetched metadata for. Each row includes id, full_name, category, installed, and whether it's custom. " +
				"Use this to find a repository's id before calling ha_hacs_download_repository or " +
				"ha_hacs_remove_repository.",
			inputSchema: {
				categories: z
					.array(z.string())
					.optional()
					.describe("Filter to these categories (e.g. ['integration']). Omit for all.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ categories }) =>
			runTool(ctx.logger, "ha_hacs_list_repositories", async () => {
				const store = await openStore(ctx);
				const repositories = await listRepositories(store, categories);
				return jsonResult({ store: store.store, count: repositories.length, repositories });
			})
	);

	server.registerTool(
		"ha_hacs_add_repository",
		{
			title: "Add a custom community store repository",
			description:
				"Add a custom repository to the community store (the Marketplace, or HACS before 2026.11) by " +
				"GitHub 'owner/repo' (or its URL) and category ('integration', 'plugin', 'theme', 'template'; " +
				"HACS also takes 'python_script' and 'appdaemon'). This only registers it — call " +
				"ha_hacs_download_repository afterwards to actually install it. Requires ha:config: this is " +
				"how a repository the catalogue doesn't list (a fork, a private project, one not yet in the " +
				"default list) becomes installable at all. A catalogue repository needs no adding.\n\n" +
				"The Marketplace only adds custom repositories once the admin has connected GitHub in " +
				"Settings → Marketplace. HACS reports success even when an add silently failed, so this " +
				"tool confirms by re-listing repositories and checking the new one actually appears.",
			inputSchema: {
				repository: z.string().describe("GitHub 'owner/repo' or its URL, e.g. 'me/my-integration'."),
				category: z
					.string()
					.describe("Category: integration, plugin, theme or template (HACS also python_script, appdaemon).")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ repository, category }) =>
			runTool(ctx.logger, "ha_hacs_add_repository", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(refuseWrite(ctx));
				}
				const store = await openStore(ctx);
				const existing = await resolveRepository(store, repository);
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
				await store.send("add", { repository, category: category.toLowerCase() });
				// HACS clones and indexes the repo asynchronously; give it a moment
				// before checking whether the add actually took.
				await new Promise((resolve) => setTimeout(resolve, 2000));
				const added = await resolveRepository(store, repository);
				if (!added) {
					return errorResult(
						`${STORE_NAME[store.store]} did not accept '${repository}' as a ${category} repository. Common causes: ` +
							"the category doesn't match what's in hacs.json on the default branch, the repo " +
							"lacks a valid manifest for that category, or it's already in the default store " +
							"under a different id."
					);
				}
				return jsonResult({
					added: true,
					store: store.store,
					repository: added,
					next: `Call ha_hacs_download_repository with repository_id '${added.id}' to install it.`
				});
			})
	);

	server.registerTool(
		"ha_hacs_download_repository",
		{
			title: "Install (download) a community store repository",
			description:
				"Install or update a repository the community store (the Marketplace, or HACS before 2026.11) " +
				"already knows about — this is the step that actually writes its files into the config " +
				"directory. Accepts either the repository id (from ha_hacs_list_repositories or " +
				"ha_hacs_add_repository) or its 'owner/repo' full name. With HACS a newly installed " +
				"integration needs a Home Assistant restart before it can be set up; the Marketplace " +
				"loads a first install without one (it raises a repair when a restart is needed). " +
				"The Marketplace refuses until the admin has accepted its warning in Settings → " +
				"Marketplace, and won't replace a built-in integration from here. Requires ha:config.",
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
				const store = await openStore(ctx);
				const row = await resolveRepository(store, repository);
				if (!row) {
					return errorResult(
						`No ${STORE_NAME[store.store]} repository matches '${repository}'. Add it first with ha_hacs_add_repository, ` +
							"or check ha_hacs_list_repositories for the right id/full_name."
					);
				}
				const params: Record<string, unknown> = { repository: row.id };
				if (version) {
					params.version = version;
				}
				await store.send("install", params);
				const after = await resolveRepository(store, row.id);
				return jsonResult({
					installed: true,
					store: store.store,
					repository: after ?? row,
					next:
						store.store === "marketplace"
							? "A new integration can be set up straight away; if Home Assistant raised a " +
								"'restart required' repair, restart first."
							: "If this is a new integration, restart Home Assistant before setting it up."
				});
			})
	);

	server.registerTool(
		"ha_hacs_remove_repository",
		{
			title: "Remove a community store repository",
			description:
				"Uninstall a repository's files and stop the community store (the Marketplace, or HACS " +
				"before 2026.11) tracking it as custom. " +
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
				const store = await openStore(ctx);
				const row = await resolveRepository(store, repository);
				if (!row) {
					return errorResult(`No ${STORE_NAME[store.store]} repository matches '${repository}'.`);
				}
				if (row.installed) {
					await store.send("uninstall", { repository: row.id });
				}
				await store.send("untrack", { repository: row.id });
				return jsonResult({ removed: true, store: store.store, repository: row });
			})
	);
}

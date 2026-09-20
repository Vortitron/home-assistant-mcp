import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Supervisor / add-on store tools via the Home Assistant WebSocket
 * ``supervisor/api`` command. Works in direct mode and in VomeHome brokered
 * mode (portal proxies WS commands when the token has ha:config).
 */

const DEFAULT_VOME_REPO = "https://github.com/Vortitron/VomeSync";

interface SupervisorApiResult {
	result?: unknown;
	data?: unknown;
	message?: string;
	[key: string]: unknown;
}

async function supervisorApi(
	ctx: ToolContext,
	endpoint: string,
	method: string,
	data?: Record<string, unknown>
): Promise<unknown> {
	const command: Record<string, unknown> = {
		type: "supervisor/api",
		endpoint,
		method: method.toLowerCase()
	};
	if (data !== undefined) {
		command.data = data;
	}
	return ctx.ws.sendCommand(command);
}

function unwrap(result: unknown): unknown {
	if (result && typeof result === "object") {
		const obj = result as SupervisorApiResult;
		if (obj.data !== undefined) return obj.data;
		if (obj.result !== undefined) return obj.result;
	}
	return result;
}

// Supervisor answers a repo re-add with "already in the store", not
// "already exists" — the two guards used to only catch the latter, so a
// repo that was already present made the whole tool abort as if it had
// failed instead of moving on to the install step.
const REPO_ALREADY_PRESENT = /already exists|already in the store|already added/i;

// Supervisor installs by pulling/building a container image, which can run
// well past the broker's own request timeout. That surfaces here as a bare
// 502, but the install job keeps running server-side and often succeeds —
// the only way to tell is to poll /addons/<slug>/info afterwards.
const GATEWAY_TIMEOUT = /\b502\b|bad gateway|gateway.*time ?out|\btimed? ?out\b/i;

async function pollAddonInstalled(
	ctx: ToolContext,
	slug: string,
	{ attempts = 6, delayMs = 5000 }: { attempts?: number; delayMs?: number } = {}
): Promise<unknown | null> {
	for (let i = 0; i < attempts; i++) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		try {
			return unwrap(await supervisorApi(ctx, `/addons/${slug}/info`, "get"));
		} catch {
			// Not installed yet (or still building) — keep waiting.
		}
	}
	return null;
}

type InstallOutcome =
	| { ok: true; result: unknown; note?: string }
	| { ok: false; error: string };

async function attemptInstall(ctx: ToolContext, slug: string): Promise<InstallOutcome> {
	try {
		const result = await supervisorApi(ctx, `/store/addons/${slug}/install`, "post");
		return { ok: true, result: unwrap(result) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!GATEWAY_TIMEOUT.test(message)) {
			return { ok: false, error: message };
		}
		const info = await pollAddonInstalled(ctx, slug);
		if (!info) {
			return { ok: false, error: message };
		}
		return {
			ok: true,
			result: info,
			note: `The install request returned "${message.slice(0, 120)}", but the add-on is installed — the build outlasted the request, it did not fail.`
		};
	}
}

function findVomeSlug(addons: unknown): string | null {
	if (!Array.isArray(addons)) return null;
	for (const item of addons) {
		if (!item || typeof item !== "object") continue;
		const row = item as { slug?: string; name?: string; repository?: string };
		const slug = String(row.slug || "");
		const name = String(row.name || "").toLowerCase();
		const repo = String(row.repository || "").toLowerCase();
		if (slug === "vome" || slug.endsWith("_vome") || name === "vome") {
			return slug;
		}
		if (repo.includes("vomesync") && (slug.includes("vome") || name.includes("vome"))) {
			return slug;
		}
	}
	return null;
}

export function registerAddonTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_supervisor_api",
		{
			title: "Call Home Assistant Supervisor API",
			description:
				"Call a Supervisor endpoint through Home Assistant's supervisor/api WebSocket command (e.g. /addons, /store/addons, /store/repositories). Requires a Supervised / HAOS install and ha:config for mutating methods. Use this for add-on store operations.",
			inputSchema: {
				endpoint: z
					.string()
					.describe("Supervisor API path, e.g. /store/repositories or /addons/core_mosquitto/info"),
				method: z
					.enum(["get", "post", "put", "delete"])
					.default("get")
					.describe("HTTP method"),
				data: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Optional JSON body for POST/PUT")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ endpoint, method, data }) =>
			runTool(ctx.logger, "ha_supervisor_api", async () => {
				const safety = ctx.instances.currentSafety();
				if (!safety.allowWrite && method !== "get") {
					return errorResult(
						ctx.instances.brokered
							? "Refused: Supervisor writes are blocked locally for this instance " +
								"(write:false in VOMEHOME_INSTANCES). Otherwise the API key decides."
							: "Writes disabled (set HA_ALLOW_WRITE=true in direct mode)."
					);
				}
				const result = await supervisorApi(ctx, endpoint, method, data);
				return jsonResult({ endpoint, method, result: unwrap(result) });
			})
	);

	server.registerTool(
		"ha_addon_install_vome",
		{
			title: "Install the Vome add-on",
			description:
				"Developer helper: add the VomeSync GitHub add-on repository to the Supervisor store (if missing), install the Vome add-on, and start it. Requires HAOS/Supervised. In brokered mode the API key's ha:config scope is authoritative — no HA_ALLOW_WRITE env flag needed. After install, restart Home Assistant once so custom_components/vomesync is loaded, then add the Vome integration.",
			inputSchema: {
				repository_url: z
					.string()
					.default(DEFAULT_VOME_REPO)
					.describe("Add-on repository git URL (default: https://github.com/Vortitron/VomeSync)"),
				skip_start: z
					.boolean()
					.default(false)
					.describe("If true, install but do not start the add-on")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ repository_url, skip_start }) =>
			runTool(ctx.logger, "ha_addon_install_vome", async () => {
				const safety = ctx.instances.currentSafety();
				if (!safety.allowWrite || !safety.allowConfigWrite) {
					return errorResult(
						ctx.instances.brokered
							? "Refused: installing add-ons is blocked locally for this instance " +
								"(write/config false in VOMEHOME_INSTANCES). Otherwise the API key decides."
							: "Refused: installing add-ons needs HA_ALLOW_WRITE and HA_ALLOW_CONFIG_WRITE in direct mode."
					);
				}
				const steps: Array<Record<string, unknown>> = [];
				const repoUrl = repository_url || DEFAULT_VOME_REPO;

				try {
					const addRepo = await supervisorApi(ctx, "/store/repositories", "post", {
						repository: repoUrl
					});
					steps.push({ step: "add_repository", ok: true, result: unwrap(addRepo) });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (REPO_ALREADY_PRESENT.test(message)) {
						steps.push({ step: "add_repository", ok: true, note: "already added" });
					} else {
						steps.push({ step: "add_repository", ok: false, error: message });
						return errorResult(
							`Failed to add repository ${repoUrl}: ${message}. ` +
								`Is this a Supervised/HAOS instance? (Container-only HA has no add-on store.)`
						);
					}
				}

				// Give Supervisor a moment to clone/index the repo.
				await new Promise((resolve) => setTimeout(resolve, 2500));

				let slug: string | null = null;
				try {
					const store = unwrap(await supervisorApi(ctx, "/store/addons", "get"));
					const list =
						store && typeof store === "object" && Array.isArray((store as { addons?: unknown }).addons)
							? (store as { addons: unknown[] }).addons
							: store;
					slug = findVomeSlug(list);
					steps.push({
						step: "resolve_slug",
						ok: Boolean(slug),
						slug,
						scanned: Array.isArray(list) ? list.length : 0
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return errorResult(`Added the repository but could not list store add-ons: ${message}`);
				}

				if (!slug) {
					return errorResult(
						`Repository added but no Vome add-on was found in the store. ` +
							`Confirm ${repoUrl} has repository.yaml at the repo root and a vome/config.yaml folder on the default branch.`
					);
				}

				const first = await attemptInstall(ctx, slug);
				if (first.ok) {
					steps.push({ step: "install", ok: true, slug, result: first.result, note: first.note });
				} else if (/already installed/i.test(first.error)) {
					steps.push({ step: "install", ok: true, slug, note: "already installed" });
				} else if (/no host internet|internet_host/i.test(first.error)) {
					// Supervisor job gate: host_internet false even when git clone worked.
					try {
						await supervisorApi(ctx, "/jobs/options", "post", {
							ignore_conditions: ["internet_host"]
						});
						steps.push({
							step: "ignore_internet_host",
							ok: true,
							note: "Supervisor reported no host internet; temporarily ignoring internet_host"
						});
					} catch (optionsError) {
						const optionsMessage =
							optionsError instanceof Error ? optionsError.message : String(optionsError);
						steps.push({ step: "ignore_internet_host", ok: false, error: optionsMessage });
						return jsonResult({ ok: false, slug, steps, error: optionsMessage });
					}

					const retry = await attemptInstall(ctx, slug);

					// Put the protection back either way. Leaving a job condition
					// ignored is what makes Home Assistant show "Unsupported system
					// — Protections disabled" from then on, long after the install
					// it was needed for has finished.
					try {
						await supervisorApi(ctx, "/jobs/options", "post", { ignore_conditions: [] });
						steps.push({ step: "restore_internet_host", ok: true });
					} catch (restoreError) {
						const restoreMessage =
							restoreError instanceof Error ? restoreError.message : String(restoreError);
						steps.push({
							step: "restore_internet_host",
							ok: false,
							error: restoreMessage,
							note:
								"Protections are still disabled — Home Assistant will report this system " +
								"as unsupported. Clear it with: ha jobs options --ignore-conditions ''"
						});
					}

					if (retry.ok) {
						steps.push({ step: "install", ok: true, slug, result: retry.result, note: retry.note });
					} else {
						steps.push({ step: "install", ok: false, slug, error: retry.error });
						return jsonResult({
							ok: false,
							slug,
							steps,
							error: retry.error,
							hint:
								"Supervisor blocked install (no host internet). On the HA host run: " +
								"ha jobs options --ignore-conditions internet_host  then retry install, " +
								"or fix DNS/connectivity so Supervisor's host_internet check passes."
						});
					}
				} else {
					steps.push({ step: "install", ok: false, slug, error: first.error });
					return jsonResult({
						ok: false,
						slug,
						steps,
						error: first.error,
						hint: GATEWAY_TIMEOUT.test(first.error)
							? `The install request timed out and ${slug} was still not installed after polling. ` +
								`Supervisor may yet be building it — check ha_supervisor_api GET /addons/${slug}/info.`
							: undefined
					});
				}

				if (!skip_start) {
					try {
						const started = await supervisorApi(ctx, `/addons/${slug}/start`, "post");
						steps.push({ step: "start", ok: true, slug, result: unwrap(started) });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (/already running|not stopped/i.test(message)) {
							steps.push({ step: "start", ok: true, slug, note: "already running" });
						} else {
							steps.push({ step: "start", ok: false, slug, error: message });
						}
					}
				}

				return jsonResult({
					ok: true,
					slug,
					repository: repoUrl,
					next_steps: [
						"Restart Home Assistant Core once so custom_components/vomesync is loaded.",
						"Settings → Devices & services → Add Integration → Vome.",
						"Open the Vome sidebar panel (add-on ingress) for remote access / LAN tunnels."
					],
					steps
				});
			})
	);
}

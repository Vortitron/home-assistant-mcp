import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateDomainWrite } from "../safety.js";
import type { HaConfig } from "../ha/types.js";
import { briefly } from "../ha/restart.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/** The longest ha_wait_until_running waits: a restart takes about a minute, a slow one two. */
export const WAIT_MAX_SECONDS = 120;
const WAIT_DEFAULT_SECONDS = 90;
const WAIT_INTERVAL_MS = 5000;

export interface WaitOutcome {
	running: boolean;
	waited_seconds: number;
	checks: number;
	/** Last core state Home Assistant reported, or null when it never answered. */
	state: string | null;
	version?: string;
	last_error?: string;
}

/**
 * Polls Home Assistant's config until its core state is RUNNING or the time
 * is up. Each failure (502s, refused connections, "no relay connection")
 * counts as "not yet" — those are what a restart looks like.
 */
export async function waitUntilRunning(
	getConfig: () => Promise<HaConfig>,
	timeoutMs: number,
	clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	}
): Promise<WaitOutcome> {
	const started = clock.now();
	let checks = 0;
	let state: string | null = null;
	let lastError: string | undefined;
	for (;;) {
		checks++;
		try {
			const config = await getConfig();
			state = typeof config?.state === "string" ? config.state : null;
			lastError = undefined;
			// An old Home Assistant without `state` that answers is running.
			if (state === "RUNNING" || state === null) {
				return {
					running: true,
					waited_seconds: Math.round((clock.now() - started) / 1000),
					checks,
					state: state ?? "RUNNING",
					...(typeof config?.version === "string" ? { version: config.version } : {})
				};
			}
		} catch (error) {
			lastError = briefly(error);
		}
		const left = timeoutMs - (clock.now() - started);
		if (left <= 0) {
			return {
				running: false,
				waited_seconds: Math.round((clock.now() - started) / 1000),
				checks,
				state,
				...(lastError ? { last_error: lastError } : {})
			};
		}
		await clock.sleep(Math.min(WAIT_INTERVAL_MS, left));
	}
}

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_wait_until_running",
		{
			title: "Wait until Home Assistant is running",
			description:
				"Wait for Home Assistant to finish restarting: checks its core state every 5 seconds until it is " +
				"RUNNING, for at most timeout_seconds (default 90, at most 120). Use it after a restart, or when a " +
				"tool said Home Assistant is restarting, instead of retrying calls blindly. Read-only.",
			inputSchema: {
				timeout_seconds: z
					.number()
					.int()
					.positive()
					.max(WAIT_MAX_SECONDS)
					.optional()
					.describe(`How long to wait at most (default ${WAIT_DEFAULT_SECONDS}, at most ${WAIT_MAX_SECONDS}).`)
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ timeout_seconds }) =>
			runTool(ctx.logger, "ha_wait_until_running", async () => {
				const seconds = Math.min(timeout_seconds ?? WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS);
				const outcome = await waitUntilRunning(() => ctx.rest.getConfig(), seconds * 1000);
				if (outcome.running) {
					return jsonResult(outcome);
				}
				return errorResult(
					`Home Assistant is still not running after ${outcome.waited_seconds} s ` +
						`(${outcome.state ? `core state: ${outcome.state}` : "it did not answer"}` +
						`${outcome.last_error ? `; last error: ${outcome.last_error}` : ""}). ` +
						"A restart that takes this long has usually failed to start: read ha_get_error_log or " +
						"ha_get_supervisor_log (core) once it answers, or check the home."
				);
			})
	);


	server.registerTool(
		"ha_get_config",
		{
			title: "Get Home Assistant config",
			description:
				"Return core Home Assistant configuration: version, location name, time zone, unit system and the list of loaded integrations/components. A good first call to understand the instance.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_get_config", async () => {
				const config = await ctx.rest.getConfig();
				return jsonResult({
					version: config.version ?? null,
					location_name: config.location_name ?? null,
					time_zone: config.time_zone ?? null,
					unit_system: config.unit_system ?? null,
					state: config.state ?? null,
					component_count: Array.isArray(config.components) ? config.components.length : null,
					components: config.components ?? []
				});
			})
	);

	server.registerTool(
		"ha_fire_event",
		{
			title: "Fire an event",
			description:
				"Fire a custom event on the Home Assistant event bus (advanced). Useful for triggering event-based automations during testing. Requires writes to be enabled.",
			inputSchema: {
				event_type: z.string().describe("Event type, e.g. 'my_custom_event'."),
				event_data: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Optional event data payload.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ event_type, event_data }) =>
			runTool(ctx.logger, "ha_fire_event", async () => {
				if (!ctx.instances.currentSafety().allowWrite) {
					return errorResult(
						"Refused: firing events requires writes enabled for the active instance (HA_ALLOW_WRITE, or this instance's write flag in VOMEHOME_INSTANCES)."
					);
				}
				const result = await ctx.rest.fireEvent(event_type, event_data);
				return jsonResult(result);
			})
	);

	server.registerTool(
		"ha_reload_automations",
		{
			title: "Reload automations",
			description:
				"Reload automations from configuration without restarting Home Assistant (calls automation.reload). Requires writes to be enabled.",
			inputSchema: {},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_reload_automations", async () => {
				const decision = evaluateDomainWrite("automation", ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				await ctx.rest.callService("automation", "reload");
				return jsonResult({ reloaded: true });
			})
	);
}

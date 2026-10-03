import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HaState } from "../ha/types.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Vome's health score for the home: what its check found and how to fix it.
 *
 * The Vome integration publishes each finished check on a sensor (the score
 * as its state, the findings, summary and categories as attributes), so the
 * report is read from the home's own states: a read-only key reaches it, and
 * nothing here talks to Vome. The entity id is not fixed (it comes from the
 * device and entity names: `sensor.vome_vome_health_score` on most homes), so
 * the sensor is found by what it carries.
 */

const INTEGRATION_NOTE =
	"It needs the Vome integration (the Vome app in Home Assistant, or Vome from HACS); vome_health_check runs a first check.";

/** The health score sensor: the one carrying findings, out of 100. Newest report first if there are several. */
function findHealthSensor(states: HaState[]): HaState | undefined {
	return states
		.filter((state) => {
			const attributes = state.attributes ?? {};
			return (
				state.entity_id.startsWith("sensor.") &&
				Array.isArray(attributes.findings) &&
				(attributes.unit_of_measurement === "/100" || /health_score$/.test(state.entity_id))
			);
		})
		.sort((a, b) => Number(b.attributes?.generated_at ?? 0) - Number(a.attributes?.generated_at ?? 0))[0];
}

export function registerHealthTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"vome_health_report",
		{
			title: "Read the home's health score",
			description:
				"Vome's health score for this Home Assistant, out of 100, with everything its check found: each finding " +
				"has a severity (warn, advice, info), a title, the evidence, a recommendation and often the exact " +
				"entities involved — devices flooding the recorder, entities left behind by removed integrations, " +
				"automations that are off or never run, batteries not reporting, error noise. Use it to see what is " +
				"wrong with a home and fix it, finding by finding; then vome_health_check re-scores it. " +
				INTEGRATION_NOTE,
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "vome_health_report", async () => {
				const sensor = findHealthSensor(await ctx.rest.getStates());
				if (!sensor) {
					return jsonResult({ found: false, note: `No health score on this home yet. ${INTEGRATION_NOTE}` });
				}
				const attributes = sensor.attributes ?? {};
				const generated = Number(attributes.generated_at);
				const score = Number(sensor.state);
				return jsonResult({
					found: true,
					entity_id: sensor.entity_id,
					score: Number.isFinite(score) ? score : null,
					summary: attributes.summary ?? "",
					generated_at: Number.isFinite(generated) && generated > 0 ? new Date(generated * 1000).toISOString() : null,
					categories: attributes.categories ?? [],
					findings: attributes.findings ?? [],
					saved_to_account: attributes.saved_to_account ?? null,
					...(attributes.health_url ? { health_url: attributes.health_url } : {}),
					...(attributes.keep_it_url ? { keep_it_url: attributes.keep_it_url } : {}),
					...(attributes.deleted_in_seconds !== undefined ? { deleted_in_seconds: attributes.deleted_in_seconds } : {})
				});
			})
	);

	server.registerTool(
		"vome_health_check",
		{
			title: "Run a fresh health check",
			description:
				"Start a fresh Vome health check on this Home Assistant: after fixing findings, this is how the score " +
				"catches up. It runs at Vome and takes a couple of minutes; the new report replaces the old one, so " +
				"read it with vome_health_report (its generated_at changes when it lands). On a home not linked to " +
				"Vome yet, the integration opens a temporary link first (deleted after a day unless someone signs " +
				"in). Requires write access. " +
				INTEGRATION_NOTE,
			inputSchema: {
				use_ai: z
					.boolean()
					.optional()
					.describe("Include Vome's written summary of the findings (default true).")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ use_ai }) =>
			runTool(ctx.logger, "vome_health_check", async () => {
				if (!ctx.instances.currentSafety().allowWrite) {
					return errorResult("Refused: running a health check requires write access for the active instance.");
				}
				const before = findHealthSensor(await ctx.rest.getStates());
				const response = await ctx.rest.callService("vomesync", "health_score_run", use_ai === undefined ? {} : { use_ai });
				return jsonResult({
					started: true,
					previous_score: before ? Number(before.state) || null : null,
					previous_generated_at: before?.attributes?.generated_at ?? null,
					note: "The check runs at Vome and takes a couple of minutes. Read the new report with vome_health_report; its generated_at changes when it lands.",
					response
				});
			})
	);
}

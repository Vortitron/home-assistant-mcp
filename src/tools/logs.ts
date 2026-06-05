import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult, textResult, runTool, type ToolContext } from "./helpers.js";

const DEFAULT_TAIL_LINES = 200;

function tail(text: string, lines: number): string {
	const all = text.split("\n");
	if (all.length <= lines) {
		return text;
	}
	return all.slice(all.length - lines).join("\n");
}

export function registerLogTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_check_config",
		{
			title: "Check configuration",
			description:
				"Validate the current Home Assistant configuration (equivalent to Developer Tools -> Check configuration). Returns 'valid' or the specific errors. Run this after editing YAML and before reloading.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_check_config", async () => {
				const result = await ctx.rest.checkConfig();
				return jsonResult(result);
			})
	);

	server.registerTool(
		"ha_get_error_log",
		{
			title: "Get error log",
			description:
				"Return the tail of the Home Assistant error log. Use this to debug why an automation, integration or template failed.",
			inputSchema: {
				tail_lines: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(`Number of trailing lines to return (default ${DEFAULT_TAIL_LINES}).`)
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ tail_lines }) =>
			runTool(ctx.logger, "ha_get_error_log", async () => {
				const log = await ctx.rest.getErrorLog();
				return textResult(tail(log, tail_lines ?? DEFAULT_TAIL_LINES) || "(error log is empty)");
			})
	);

	server.registerTool(
		"ha_get_logbook",
		{
			title: "Get logbook",
			description:
				"Return human-readable logbook entries (what happened and when), optionally filtered to a single entity and time window. Times are ISO 8601.",
			inputSchema: {
				entity_id: z.string().optional().describe("Restrict to a single entity_id."),
				start_time: z.string().optional().describe("ISO 8601 start timestamp."),
				end_time: z.string().optional().describe("ISO 8601 end timestamp.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ entity_id, start_time, end_time }) =>
			runTool(ctx.logger, "ha_get_logbook", async () => {
				const entries = await ctx.rest.getLogbook({
					entityId: entity_id,
					startTime: start_time,
					endTime: end_time
				});
				return jsonResult({ count: entries.length, entries });
			})
	);
}

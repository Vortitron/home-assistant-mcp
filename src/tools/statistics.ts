import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Long-term statistics: what the Energy dashboard and statistics graphs draw.
 *
 * A meter that briefly reads nonsense (a heat pump's cloud reporting 183 kW
 * for fifteen minutes, GamlaBio 22 Oct 2026) puts tens of kWh into one
 * five-minute bucket, and from then on the Energy dashboard shows that day
 * wrong. Home Assistant's own fix is Developer Tools → Statistics → adjust,
 * which was only reachable through a browser. These are the same two steps:
 * find the bucket (`largest_changes` is the dialog's "Outliers" list) and
 * set it to what it should have been.
 */

const PERIODS = ["5minute", "hour", "day", "week", "month"] as const;

type StatRow = {
	start: number | string;
	end?: number | string;
	change?: number | null;
	sum?: number | null;
	state?: number | null;
	mean?: number | null;
	min?: number | null;
	max?: number | null;
};

/** HA sends bucket times as epoch milliseconds (older releases: ISO strings). */
function iso(value: number | string | undefined): string | null {
	if (value === undefined || value === null) return null;
	const date = typeof value === "number" ? new Date(value) : new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function shapeRow(row: StatRow): Record<string, unknown> {
	const out: Record<string, unknown> = { start: iso(row.start), end: iso(row.end) };
	for (const key of ["change", "sum", "state", "mean", "min", "max"] as const) {
		if (row[key] !== undefined && row[key] !== null) out[key] = row[key];
	}
	return out;
}

async function statisticUnit(ctx: ToolContext, statisticId: string): Promise<string | null> {
	const meta = await ctx.ws.sendCommand<Array<Record<string, unknown>>>({
		type: "recorder/get_statistics_metadata",
		statistic_ids: [statisticId]
	});
	const entry = (meta ?? []).find((item) => item.statistic_id === statisticId);
	if (!entry) return null;
	return (entry.statistics_unit_of_measurement as string | undefined) ?? (entry.unit_of_measurement as string | undefined) ?? null;
}

async function fiveMinuteChange(ctx: ToolContext, statisticId: string, start: Date): Promise<number | null> {
	const end = new Date(start.getTime() + 5 * 60 * 1000);
	const result = await ctx.ws.sendCommand<Record<string, StatRow[]>>({
		type: "recorder/statistics_during_period",
		statistic_ids: [statisticId],
		start_time: start.toISOString(),
		end_time: end.toISOString(),
		period: "5minute",
		types: ["change"]
	});
	const row = (result?.[statisticId] ?? []).find((item) => {
		const rowStart = typeof item.start === "number" ? item.start : Date.parse(String(item.start));
		return rowStart === start.getTime();
	});
	return row && typeof row.change === "number" ? row.change : null;
}

export function registerStatisticsTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_get_statistics",
		{
			title: "Read long-term statistics",
			description:
				"Read the long-term statistics the Energy dashboard and statistics graphs are drawn from, for " +
				"one or more statistic ids (a sensor's statistic id is its entity_id), per 5minute, hour, day, " +
				"week or month: each bucket's change (energy used in it), sum, state, mean, min and max where " +
				"they apply. Set largest_changes to get only the N buckets with the biggest change, biggest first " +
				"— the same list as the Outliers button in Developer Tools → Statistics, and the way to find a " +
				"meter's glitch before correcting it with ha_adjust_statistic.",
			inputSchema: {
				statistic_ids: z.array(z.string()).min(1).describe("Statistic ids, e.g. ['sensor.heat_pump_energy']."),
				start_time: z.string().describe("ISO 8601 start, e.g. 2026-10-22T00:00:00+02:00."),
				end_time: z.string().optional().describe("ISO 8601 end (default: now)."),
				period: z.enum(PERIODS).optional().describe("Bucket size (default hour)."),
				types: z
					.array(z.enum(["change", "sum", "state", "mean", "min", "max", "last_reset"]))
					.optional()
					.describe("Columns to return (default change, sum, state)."),
				largest_changes: z
					.number()
					.int()
					.positive()
					.max(100)
					.optional()
					.describe("Return only the N buckets with the largest |change|, per statistic.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ statistic_ids, start_time, end_time, period, types, largest_changes }) =>
			runTool(ctx.logger, "ha_get_statistics", async () => {
				const command: Record<string, unknown> = {
					type: "recorder/statistics_during_period",
					statistic_ids,
					start_time,
					period: period ?? "hour",
					types: largest_changes ? ["change"] : (types ?? ["change", "sum", "state"])
				};
				if (end_time) command.end_time = end_time;
				const result = (await ctx.ws.sendCommand<Record<string, StatRow[]>>(command)) ?? {};
				const statistics: Record<string, unknown> = {};
				for (const id of statistic_ids) {
					let rows = result[id] ?? [];
					if (largest_changes) {
						rows = rows
							.filter((row) => typeof row.change === "number")
							.sort((a, b) => Math.abs(Number(b.change)) - Math.abs(Number(a.change)))
							.slice(0, largest_changes);
					}
					statistics[id] = rows.map(shapeRow);
				}
				return jsonResult({ period: command.period, statistics });
			})
	);

	server.registerTool(
		"ha_adjust_statistic",
		{
			title: "Correct a long-term statistic",
			description:
				"Correct one bucket of a long-term statistic, as Developer Tools → Statistics → adjust does: " +
				"for a meter that briefly reported nonsense and put it into the Energy dashboard. Give the " +
				"statistic id and the start of the 5-minute bucket (from ha_get_statistics with period " +
				"5minute), then either new_value (what that bucket's change should have been; the tool reads " +
				"the current one and adjusts by the difference) or adjustment (the amount to add, negative to " +
				"remove). Every later sum moves by the same amount, so the meter's history stays continuous. " +
				"The sensor's own state is not touched. Requires HA_ALLOW_CONFIG_WRITE (ha:config).",
			inputSchema: {
				statistic_id: z.string().describe("Statistic id, e.g. sensor.heat_pump_energy."),
				start_time: z
					.string()
					.describe("Start of the 5-minute bucket to correct, ISO 8601 (e.g. 2026-10-22T13:20:00Z)."),
				new_value: z.number().optional().describe("What the bucket's change should be, in the statistic's unit."),
				adjustment: z
					.number()
					.optional()
					.describe("Amount to add to the sum from this bucket on (negative to remove). Use instead of new_value.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ statistic_id, start_time, new_value, adjustment }) =>
			runTool(ctx.logger, "ha_adjust_statistic", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) return errorResult(`Refused: ${decision.reason}`);
				if ((new_value === undefined) === (adjustment === undefined)) {
					return errorResult("Pass exactly one of new_value or adjustment.");
				}
				const start = new Date(start_time);
				if (Number.isNaN(start.getTime())) return errorResult(`start_time is not a date: ${start_time}`);
				if (start.getTime() % (5 * 60 * 1000) !== 0) {
					return errorResult("start_time must be the start of a 5-minute bucket (minutes a multiple of 5, seconds 0).");
				}
				const unit = await statisticUnit(ctx, statistic_id);
				if (unit === null) return errorResult(`No long-term statistic called ${statistic_id}.`);

				let before: number | null = null;
				let delta = adjustment ?? 0;
				if (new_value !== undefined) {
					before = await fiveMinuteChange(ctx, statistic_id, start);
					if (before === null) {
						return errorResult(`No 5-minute statistic for ${statistic_id} starting ${start.toISOString()}.`);
					}
					delta = new_value - before;
				}
				if (delta === 0) return jsonResult({ adjusted: false, note: "Nothing to change.", before });

				await ctx.ws.sendCommand({
					type: "recorder/adjust_sum_statistics",
					statistic_id,
					start_time: start.toISOString(),
					adjustment: delta,
					adjustment_unit_of_measurement: unit
				});
				const after = await fiveMinuteChange(ctx, statistic_id, start).catch(() => null);
				return jsonResult({
					adjusted: true,
					statistic_id,
					start_time: start.toISOString(),
					unit,
					adjustment: delta,
					before,
					after
				});
			})
	);
}

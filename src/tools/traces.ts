import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HaTraceDetail, HaTraceSummary } from "../ha/types.js";
import { resolveAutomationId } from "./automations.js";
import { errorResult, jsonResult, runTool, truncate, type ToolContext } from "./helpers.js";

/**
 * Automation and script *traces* — Home Assistant's per-run record of which
 * trigger fired, which conditions passed and which actions ran. For "why didn't
 * this automation do anything?" a trace beats any log: the condition that
 * returned false is recorded explicitly, and logs rarely mention it at all.
 *
 * Raw traces are big (they embed the whole config plus every step's changed
 * variables), so these tools summarise by default and dump raw only on request.
 */

const TRACE_DOMAINS = ["automation", "script"] as const;
type TraceDomain = (typeof TRACE_DOMAINS)[number];

const DEFAULT_TRACE_LIMIT = 20;
const MAX_VALUE_CHARS = 300;

/** Compact a step result/variable blob so one fat payload can't swamp the reply. */
function compact(value: unknown, maxChars = MAX_VALUE_CHARS): unknown {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (typeof text !== "string") {
		return String(value);
	}
	return text.length > maxChars ? `${text.slice(0, maxChars)}… (truncated)` : text;
}

/**
 * Resolve a user-supplied reference to the id traces are keyed by: the unique
 * id for automations, the object_id for scripts.
 */
async function resolveItemId(
	ctx: ToolContext,
	domain: TraceDomain,
	item: string
): Promise<string | undefined> {
	if (domain === "script") {
		return item.startsWith("script.") ? item.slice("script.".length) : item;
	}
	return resolveAutomationId(ctx, item);
}

interface TraceStep {
	path: string;
	timestamp: unknown;
	result?: unknown;
	error?: unknown;
	changed_variables?: unknown;
}

function stepTimestamp(step: TraceStep): string {
	return typeof step.timestamp === "string" ? step.timestamp : "";
}

/** Flatten `trace: { "condition/0": [run, …] }` into a time-ordered step list. */
function flattenSteps(trace: HaTraceDetail["trace"], includeVariables: boolean): TraceStep[] {
	if (!trace || typeof trace !== "object") {
		return [];
	}
	const steps: TraceStep[] = [];
	for (const [path, executions] of Object.entries(trace)) {
		for (const execution of Array.isArray(executions) ? executions : []) {
			const row = (execution ?? {}) as Record<string, unknown>;
			const step: TraceStep = {
				path,
				timestamp: row.timestamp ?? null
			};
			if (row.result !== undefined) {
				step.result = compact(row.result);
			}
			if (row.error !== undefined) {
				step.error = compact(row.error);
			}
			if (includeVariables && row.changed_variables !== undefined) {
				step.changed_variables = compact(row.changed_variables, 1000);
			}
			steps.push(step);
		}
	}
	return steps.sort((a, b) => stepTimestamp(a).localeCompare(stepTimestamp(b)));
}

/**
 * The one line an agent actually wants: the first step that errored or that
 * evaluated false. `script_execution: "failed_condition"` says a condition
 * stopped the run, but not which one — this does.
 */
function findFailure(steps: TraceStep[]): Record<string, unknown> | null {
	for (const step of steps) {
		if (step.error !== undefined && step.error !== null) {
			return { path: step.path, reason: "step raised an error", detail: step.error };
		}
		// Conditions record `{ result: false }`; compact() has already stringified it.
		const result = typeof step.result === "string" ? step.result : JSON.stringify(step.result ?? null);
		if (step.path.startsWith("condition") && result.includes('"result":false')) {
			return { path: step.path, reason: "condition evaluated false", detail: step.result };
		}
	}
	return null;
}

/** Pull the trigger description out of the trigger step's changed variables. */
function describeTrigger(trace: HaTraceDetail): unknown {
	const triggerSteps = trace.trace?.["trigger/0"];
	const first = Array.isArray(triggerSteps) ? (triggerSteps[0] as Record<string, unknown>) : undefined;
	const changed = first?.changed_variables as Record<string, unknown> | undefined;
	const trigger = changed?.trigger ?? (trace.variables as Record<string, unknown> | undefined)?.trigger;
	if (trigger && typeof trigger === "object") {
		const row = trigger as Record<string, unknown>;
		return {
			description: row.description ?? null,
			platform: row.platform ?? null,
			entity_id: row.entity_id ?? null
		};
	}
	return null;
}

function summariseTrace(trace: HaTraceDetail, includeVariables: boolean): Record<string, unknown> {
	const steps = flattenSteps(trace.trace, includeVariables);
	return {
		run_id: trace.run_id ?? null,
		domain: trace.domain ?? null,
		item_id: trace.item_id ?? null,
		started: trace.timestamp?.start ?? null,
		finished: trace.timestamp?.finish ?? null,
		state: trace.state ?? null,
		script_execution: trace.script_execution ?? null,
		last_step: trace.last_step ?? null,
		error: trace.error ?? null,
		trigger: describeTrigger(trace),
		failed_at: findFailure(steps),
		step_count: steps.length,
		steps
	};
}

function summariseListRow(row: HaTraceSummary): Record<string, unknown> {
	return {
		run_id: row.run_id ?? null,
		domain: row.domain ?? null,
		item_id: row.item_id ?? null,
		started: row.timestamp?.start ?? null,
		finished: row.timestamp?.finish ?? null,
		state: row.state ?? null,
		script_execution: row.script_execution ?? null,
		last_step: row.last_step ?? null,
		error: row.error ?? null
	};
}

function startedAt(row: HaTraceSummary): string {
	return typeof row.timestamp?.start === "string" ? row.timestamp.start : "";
}

export function registerTraceTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_traces",
		{
			title: "List automation/script traces",
			description:
				"List recent runs of an automation or script: when it ran, whether it finished, and how it stopped ('failed_condition' means a condition blocked it). Omit 'item' to list runs across everything in the domain. Home Assistant keeps a limited number of traces per item (5 by default), and none from before the last restart.",
			inputSchema: {
				domain: z
					.enum(TRACE_DOMAINS)
					.optional()
					.describe("Which kind of item to list traces for (default 'automation')."),
				item: z
					.string()
					.optional()
					.describe("entity_id or unique id (automation.x / the unique id; script.y / y). Omit for all."),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(`Maximum runs to return, newest first (default ${DEFAULT_TRACE_LIMIT}).`)
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ domain, item, limit }) =>
			runTool(ctx.logger, "ha_list_traces", async () => {
				const traceDomain = domain ?? "automation";
				const command: Record<string, unknown> = { type: "trace/list", domain: traceDomain };
				if (item) {
					const itemId = await resolveItemId(ctx, traceDomain, item);
					if (!itemId) {
						return errorResult(
							`Could not resolve '${item}' to a unique id. YAML automations without an 'id:' are not traced — check ha_list_automations.`
						);
					}
					command.item_id = itemId;
				}
				const result = await ctx.ws.sendCommand<HaTraceSummary[]>(command);
				const rows = (Array.isArray(result) ? result : []).sort((a, b) =>
					startedAt(b).localeCompare(startedAt(a))
				);
				const page = truncate(rows, limit ?? DEFAULT_TRACE_LIMIT);
				return jsonResult({
					domain: traceDomain,
					item: item ?? null,
					total: page.total,
					returned: page.returned,
					truncated: page.truncated,
					traces: page.items.map(summariseListRow),
					hint:
						page.total === 0
							? "No traces stored. Traces only exist for runs since the last restart; trigger the item and look again."
							: "Use ha_get_trace with a run_id (or without one for the latest run) to see step-by-step detail."
				});
			})
	);

	server.registerTool(
		"ha_get_trace",
		{
			title: "Get automation/script trace",
			description:
				"Step-by-step detail for one run: what triggered it, every condition and action in order with its result, and 'failed_at' naming the first step that errored or evaluated false. This is the tool for 'why didn't my automation run' — logs usually stay silent about a condition returning false. Omit run_id to get the most recent run. Summarised by default; set full=true for the raw trace including the config (large).",
			inputSchema: {
				item: z
					.string()
					.describe("entity_id or unique id (automation.x / the unique id; script.y / y)."),
				domain: z.enum(TRACE_DOMAINS).optional().describe("Item kind (default 'automation')."),
				run_id: z.string().optional().describe("Specific run to fetch (default: the latest)."),
				include_variables: z
					.boolean()
					.optional()
					.describe("Include each step's changed variables (default false — verbose)."),
				full: z
					.boolean()
					.optional()
					.describe("Return the raw, unsummarised trace including the item's config (default false).")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ item, domain, run_id, include_variables, full }) =>
			runTool(ctx.logger, "ha_get_trace", async () => {
				const traceDomain = domain ?? "automation";
				const itemId = await resolveItemId(ctx, traceDomain, item);
				if (!itemId) {
					return errorResult(
						`Could not resolve '${item}' to a unique id. YAML automations without an 'id:' are not traced — check ha_list_automations.`
					);
				}
				let runId = run_id;
				if (!runId) {
					const list = await ctx.ws.sendCommand<HaTraceSummary[]>({
						type: "trace/list",
						domain: traceDomain,
						item_id: itemId
					});
					const latest = (Array.isArray(list) ? list : [])
						.slice()
						.sort((a, b) => startedAt(b).localeCompare(startedAt(a)))[0];
					if (!latest?.run_id) {
						return errorResult(
							`No stored traces for ${traceDomain} '${itemId}'. Traces only cover runs since the last restart — trigger it and try again.`
						);
					}
					runId = latest.run_id;
				}
				const trace = await ctx.ws.sendCommand<HaTraceDetail>({
					type: "trace/get",
					domain: traceDomain,
					item_id: itemId,
					run_id: runId
				});
				if (full) {
					return jsonResult(trace);
				}
				return jsonResult(summariseTrace(trace ?? {}, include_variables ?? false));
			})
	);
}

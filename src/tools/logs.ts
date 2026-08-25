import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HaSystemLogEntry } from "../ha/types.js";
import { evaluateDiagnosticWrite } from "../safety.js";
import {
	errorResult,
	jsonResult,
	runTool,
	textResult,
	truncate,
	type ToolContext
} from "./helpers.js";

const DEFAULT_TAIL_LINES = 200;
const DEFAULT_SYSTEM_LOG_LIMIT = 25;

/** Log levels ordered least → most severe, for "at least this level" filtering. */
const LEVELS = ["debug", "info", "warning", "error", "critical"] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_RANK = new Map<string, number>(LEVELS.map((level, index) => [level, index]));

/** Supervisor log sources reachable over HA's allow-listed `/api/hassio` log paths. */
const SUPERVISOR_TARGETS = ["core", "supervisor", "host", "addon", "audio", "dns", "multicast"] as const;
type SupervisorTarget = (typeof SUPERVISOR_TARGETS)[number];

function tail(text: string, lines: number): string {
	const all = text.split("\n");
	if (all.length <= lines) {
		return text;
	}
	return all.slice(all.length - lines).join("\n");
}

/** HA stamps system-log entries with epoch seconds (float); agents want ISO. */
function toIso(epochSeconds: unknown): string | null {
	if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) {
		return null;
	}
	return new Date(epochSeconds * 1000).toISOString();
}

/** `message` is a list when the same logger emitted several distinct strings. */
function joinMessage(message: HaSystemLogEntry["message"]): string {
	if (Array.isArray(message)) {
		return message.filter((part) => typeof part === "string").join(" | ");
	}
	return typeof message === "string" ? message : "";
}

function formatSource(source: HaSystemLogEntry["source"]): string | null {
	if (!Array.isArray(source) || source.length === 0) {
		return null;
	}
	const [file, line] = source;
	return line === undefined ? String(file) : `${String(file)}:${String(line)}`;
}

/**
 * The last non-empty line of a Python traceback is the bit that matters
 * ("ValueError: expected a number"). Surfacing just that keeps the default
 * response small while still naming the actual failure.
 */
function exceptionSummary(exception: unknown): string | null {
	if (typeof exception !== "string" || exception.trim() === "") {
		return null;
	}
	const lines = exception.trimEnd().split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]?.trim();
		if (line) {
			return line;
		}
	}
	return null;
}

function countLines(text: unknown): number {
	return typeof text === "string" && text !== "" ? text.trimEnd().split("\n").length : 0;
}

interface SystemLogFilters {
	minLevel: Level;
	contains?: string;
	logger?: string;
	includeException: boolean;
}

/** Shapes one raw `system_log/list` record into the compact form tools return. */
function summariseEntry(
	entry: HaSystemLogEntry,
	includeException: boolean
): Record<string, unknown> {
	const row: Record<string, unknown> = {
		level: typeof entry.level === "string" ? entry.level.toLowerCase() : "unknown",
		logger: entry.name ?? null,
		message: joinMessage(entry.message),
		count: typeof entry.count === "number" ? entry.count : 1,
		first_occurred: toIso(entry.first_occurred),
		last_occurred: toIso(entry.timestamp),
		source: formatSource(entry.source)
	};
	const summary = exceptionSummary(entry.exception);
	if (summary) {
		row.exception_summary = summary;
		row.exception_lines = countLines(entry.exception);
		if (includeException) {
			row.exception = entry.exception;
		}
	}
	return row;
}

function matchesFilters(entry: HaSystemLogEntry, filters: SystemLogFilters): boolean {
	const level = typeof entry.level === "string" ? entry.level.toLowerCase() : "";
	const rank = LEVEL_RANK.get(level);
	// Unknown levels are kept: better a stray row than a silently dropped error.
	if (rank !== undefined && rank < (LEVEL_RANK.get(filters.minLevel) ?? 0)) {
		return false;
	}
	if (filters.logger && !String(entry.name ?? "").toLowerCase().includes(filters.logger.toLowerCase())) {
		return false;
	}
	if (filters.contains) {
		const needle = filters.contains.toLowerCase();
		const haystack = [
			entry.name ?? "",
			joinMessage(entry.message),
			formatSource(entry.source) ?? "",
			typeof entry.exception === "string" ? entry.exception : ""
		]
			.join("\n")
			.toLowerCase();
		if (!haystack.includes(needle)) {
			return false;
		}
	}
	return true;
}

/**
 * Turn a friendly integration name into the logger path HA expects.
 * A name with a dot is already a logger path ("custom_components.vomesync");
 * a bare name is a core integration ("hue" → "homeassistant.components.hue").
 */
export function toLoggerName(integration: string): string {
	const trimmed = integration.trim();
	return trimmed.includes(".") ? trimmed : `homeassistant.components.${trimmed}`;
}

function supervisorLogPath(target: SupervisorTarget, addonSlug?: string): string {
	if (target === "addon") {
		return `/api/hassio/addons/${encodeURIComponent(addonSlug as string)}/logs`;
	}
	return `/api/hassio/${target}/logs`;
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
		"ha_get_system_log",
		{
			title: "Get system log (structured)",
			description:
				"Home Assistant's deduplicated error store: one record per distinct problem, with level, logger, source file:line, occurrence count and first/last seen. Prefer this over ha_get_error_log — 20 grouped issues instead of 200 raw lines. Filter by minimum level, logger name or free text. Full tracebacks are omitted by default (you still get the final exception line); set include_exception=true, usually narrowed with 'contains', to read a whole stack.",
			inputSchema: {
				min_level: z
					.enum(LEVELS)
					.optional()
					.describe("Minimum severity to include (default 'warning')."),
				contains: z
					.string()
					.optional()
					.describe("Case-insensitive substring matched against logger, message, source and traceback."),
				logger: z
					.string()
					.optional()
					.describe("Case-insensitive substring matched against the logger name only, e.g. 'hue'."),
				include_exception: z
					.boolean()
					.optional()
					.describe("Include full tracebacks (default false — large)."),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(`Maximum entries to return, newest first (default ${DEFAULT_SYSTEM_LOG_LIMIT}).`)
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ min_level, contains, logger, include_exception, limit }) =>
			runTool(ctx.logger, "ha_get_system_log", async () => {
				const entries = await ctx.ws.sendCommand<HaSystemLogEntry[]>({ type: "system_log/list" });
				const all = Array.isArray(entries) ? entries : [];
				const filters: SystemLogFilters = {
					minLevel: min_level ?? "warning",
					contains,
					logger,
					includeException: include_exception ?? false
				};
				const matched = all
					.filter((entry) => matchesFilters(entry, filters))
					.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
				const page = truncate(matched, limit ?? DEFAULT_SYSTEM_LOG_LIMIT);
				return jsonResult({
					total_in_log: all.length,
					matched: page.total,
					returned: page.returned,
					truncated: page.truncated,
					filters: {
						min_level: filters.minLevel,
						contains: contains ?? null,
						logger: logger ?? null,
						include_exception: filters.includeException
					},
					entries: page.items.map((entry) => summariseEntry(entry, filters.includeException))
				});
			})
	);

	server.registerTool(
		"ha_clear_system_log",
		{
			title: "Clear system log",
			description:
				"Empty Home Assistant's structured error store. The point is the debug loop: clear, reproduce the problem, then ha_get_system_log shows only what your reproduction caused. Does not touch home-assistant.log on disk. Requires HA_ALLOW_WRITE=true in direct mode.",
			inputSchema: {},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_clear_system_log", async () => {
				const decision = evaluateDiagnosticWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				await ctx.ws.sendCommand({ type: "system_log/clear" });
				return jsonResult({
					cleared: true,
					next: "Reproduce the problem, then call ha_get_system_log to see only the new entries."
				});
			})
	);

	server.registerTool(
		"ha_set_log_level",
		{
			title: "Set log level",
			description:
				"Raise or lower logging for one integration (or several) at runtime, via logger.set_level. Use this before reproducing a problem — debug on one integration, rather than global debug that drowns the log. Bare names are treated as core integrations ('hue' -> homeassistant.components.hue); anything containing a dot is used as-is ('custom_components.vomesync'). Levels reset on restart. Requires HA_ALLOW_WRITE=true in direct mode.",
			inputSchema: {
				integration: z
					.string()
					.optional()
					.describe("Integration or logger path to change, e.g. 'hue' or 'custom_components.vomesync'."),
				level: z.enum(LEVELS).optional().describe("Level to apply to 'integration'."),
				levels: z
					.record(z.string(), z.enum(LEVELS))
					.optional()
					.describe("Several at once: { \"hue\": \"debug\", \"custom_components.vomesync\": \"info\" }.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ integration, level, levels }) =>
			runTool(ctx.logger, "ha_set_log_level", async () => {
				const decision = evaluateDiagnosticWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const payload: Record<string, string> = {};
				for (const [name, value] of Object.entries(levels ?? {})) {
					payload[toLoggerName(name)] = value;
				}
				if (integration || level) {
					if (!integration || !level) {
						return errorResult(
							"Provide both 'integration' and 'level' together, or use 'levels' for several at once."
						);
					}
					payload[toLoggerName(integration)] = level;
				}
				if (Object.keys(payload).length === 0) {
					return errorResult("Nothing to set: provide 'integration' + 'level', or 'levels'.");
				}
				await ctx.rest.callService("logger", "set_level", payload);
				return jsonResult({
					applied: payload,
					note: "Levels are runtime-only and reset when Home Assistant restarts.",
					next: "ha_clear_system_log, reproduce the problem, then ha_get_system_log."
				});
			})
	);

	server.registerTool(
		"ha_get_error_log",
		{
			title: "Get error log",
			description:
				"Return the tail of the raw Home Assistant error log. ha_get_system_log is usually the better first stop (grouped and structured); reach for this one when you need the raw ordering, or lines the structured store drops.",
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
		"ha_get_supervisor_log",
		{
			title: "Get Supervisor / add-on log",
			description:
				"Tail the logs of an add-on, Home Assistant Core, the Supervisor itself, or the host — for problems that never reach HA's own error log (an add-on crash-looping, a failed install, host-level trouble). Requires a Supervised / HAOS install. Direct mode only for now: the VomeHome broker does not proxy raw Supervisor paths.",
			inputSchema: {
				target: z
					.enum(SUPERVISOR_TARGETS)
					.optional()
					.describe("Which log to read (default 'core'). Use 'addon' with addon_slug."),
				addon_slug: z
					.string()
					.optional()
					.describe("Add-on slug when target='addon', e.g. 'core_mosquitto' or the Vome slug."),
				tail_lines: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(`Number of trailing lines to return (default ${DEFAULT_TAIL_LINES}).`)
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ target, addon_slug, tail_lines }) =>
			runTool(ctx.logger, "ha_get_supervisor_log", async () => {
				const source = target ?? "core";
				if (source === "addon" && !addon_slug) {
					return errorResult("target='addon' needs addon_slug. List add-ons with ha_supervisor_api /addons.");
				}
				if (ctx.instances.brokered) {
					return errorResult(
						"Supervisor logs are not available in VomeHome brokered mode — the broker proxies the HA API, " +
							"not raw /api/hassio paths. Run with a direct HA_URL + HA_TOKEN to read them."
					);
				}
				const path = supervisorLogPath(source, addon_slug);
				const log = await ctx.rest.request<string>(path, { expect: "text" });
				const text = tail(log, tail_lines ?? DEFAULT_TAIL_LINES);
				return textResult(text || `(${source} log is empty)`);
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

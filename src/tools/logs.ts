import { z } from "zod";
import { HaApiError } from "../ha/restClient.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HaLogbookEntry, HaSystemLogEntry } from "../ha/types.js";
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

const DEFAULT_LOGBOOK_LIMIT = 500;

interface LogbookFilters {
	contains?: string;
	name?: string;
	domain?: string;
}

/** The entry's domain, or the one its entity_id implies. */
function logbookDomain(entry: HaLogbookEntry): string {
	if (typeof entry.domain === "string" && entry.domain) {
		return entry.domain;
	}
	const entityId = typeof entry.entity_id === "string" ? entry.entity_id : "";
	return entityId.includes(".") ? (entityId.split(".")[0] as string) : "";
}

export function matchesLogbookFilters(entry: HaLogbookEntry, filters: LogbookFilters): boolean {
	const lower = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");
	if (filters.name && lower(entry.name) !== filters.name.trim().toLowerCase()) {
		return false;
	}
	if (filters.domain && logbookDomain(entry).toLowerCase() !== filters.domain.trim().toLowerCase()) {
		return false;
	}
	if (filters.contains) {
		const needle = filters.contains.toLowerCase();
		if (![entry.message, entry.name, entry.entity_id].some((field) => lower(field).includes(needle))) {
			return false;
		}
	}
	return true;
}

/** An entry's time in ms: REST gives ISO strings, the WebSocket API epoch seconds. */
function logbookTime(when: unknown): number {
	if (typeof when === "number") return when * 1000;
	return typeof when === "string" ? Date.parse(when) : NaN;
}

/** Oldest first, which is how Home Assistant returns them; sorted only when every entry has a time. */
function inTimeOrder(entries: HaLogbookEntry[]): HaLogbookEntry[] {
	const times = entries.map((entry) => logbookTime(entry.when));
	if (times.some((time) => Number.isNaN(time))) {
		return entries;
	}
	return entries
		.map((entry, index) => ({ entry, time: times[index] as number, index }))
		.sort((a, b) => a.time - b.time || a.index - b.index)
		.map(({ entry }) => entry);
}

/**
 * Day-sized logbook reads.
 *
 * Home Assistant builds a logbook answer whole, in memory: a fortnight of a
 * busy home's logbook in one request ran a 4 GB VM out of memory and moved
 * the home to its standby (GamlaBio, 3 Nov 2026), and the portal now refuses
 * a read longer than a day. So a longer window is read a day at a time,
 * newest first, stopping once enough matching entries are in.
 *
 * Home Assistant's window is open at both ends (start < time < end, in its
 * recorder queries), so two reads that merely meet would both miss an entry
 * stamped exactly on the shared edge. Neighbouring reads therefore overlap by
 * a millisecond at each inner edge, and every entry is kept only by the read
 * whose own slice ([lo, hi), by the entry's time) it falls in: none dropped,
 * none twice. Each request still spans under 24 hours, overlap included, so
 * an exact 72-hour window takes four reads, not three.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_OVERLAP_MS = 1;
/** The most a read's own slice may span: a day less both overlaps (and a rounding millisecond each). */
const CHUNK_MAX_SLICE_MS = DAY_MS - 4 * CHUNK_OVERLAP_MS;
/** The most day-sized reads one call makes: about a month. */
export const MAX_LOGBOOK_CHUNKS = 31;

export interface LogbookChunk {
	/** Absent only for the single read of a call with no start_time (Home Assistant's default window). */
	startTime?: string;
	endTime?: string;
	/** Entries before this time (ms) belong to the next older read; absent at the window's start. */
	lo?: number;
	/** Entries at or after this time belong to the next newer read; absent at the window's end. */
	hi?: number;
}

/**
 * The window [start, end] as day-sized reads, newest first, or null when one
 * read covers it (24 hours or less, or a time that does not parse: then Home
 * Assistant is asked exactly as before). The window is split evenly into as
 * few reads as fit. `skippedBefore` is set when that is more than
 * {@link MAX_LOGBOOK_CHUNKS}: only the newest are made, and nothing before it
 * was read.
 */
export function logbookChunks(start: string, end: string): { chunks: LogbookChunk[]; skippedBefore?: string } | null {
	const from = Date.parse(start);
	const to = Date.parse(end);
	if (Number.isNaN(from) || Number.isNaN(to) || to - from <= DAY_MS) return null;
	const iso = (ms: number) => new Date(ms).toISOString();
	const span = to - from;
	const count = Math.ceil(span / CHUNK_MAX_SLICE_MS);
	const edge = (k: number) => (k >= count ? from : to - Math.round((k * span) / count));
	const chunks: LogbookChunk[] = [];
	for (let k = 0; k < Math.min(count, MAX_LOGBOOK_CHUNKS); k++) {
		const hi = edge(k);
		const lo = edge(k + 1);
		const newest = k === 0;
		const oldest = k === count - 1;
		chunks.push({
			startTime: oldest ? start : iso(lo - CHUNK_OVERLAP_MS),
			endTime: newest ? end : iso(hi + CHUNK_OVERLAP_MS),
			...(oldest ? {} : { lo }),
			...(newest ? {} : { hi })
		});
	}
	const last = chunks[chunks.length - 1] as LogbookChunk;
	return count > MAX_LOGBOOK_CHUNKS ? { chunks, skippedBefore: iso(last.lo as number) } : { chunks };
}

/** The entries that are this read's own (see {@link logbookChunks}). */
function ownEntries(entries: HaLogbookEntry[], chunk: LogbookChunk, untimed: Set<string>): HaLogbookEntry[] {
	return entries.filter((entry) => {
		const time = logbookTime(entry.when);
		if (Number.isNaN(time)) {
			// No time to place it by: kept once, by whichever read sees it first.
			const key = JSON.stringify(entry);
			if (untimed.has(key)) return false;
			untimed.add(key);
			return true;
		}
		return (chunk.lo === undefined || time >= chunk.lo) && (chunk.hi === undefined || time < chunk.hi);
	});
}

/** Log levels ordered least → most severe, for "at least this level" filtering. */
const LEVELS = ["debug", "info", "warning", "error", "critical"] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_RANK = new Map<string, number>(LEVELS.map((level, index) => [level, index]));

/** Supervisor log sources reachable over HA's allow-listed `/api/hassio` log paths. */
const SUPERVISOR_TARGETS = [
	"core",
	"supervisor",
	"host",
	"addon",
	"audio",
	"dns",
	"multicast",
	"observer",
	"cli"
] as const;

/** Terminal colour codes: the Supervisor's core log is coloured, the old file was not. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

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
				let log: string;
				try {
					log = await ctx.rest.getErrorLog();
				} catch (error) {
					// HA only serves /api/error_log when it writes a log file, and
					// on HAOS it no longer does (it logs to the journal), so a
					// current HAOS home 404s here. The same lines are the
					// Supervisor's core log, which is what HA's own UI reads.
					if (!(error instanceof HaApiError && error.status === 404)) throw error;
					try {
						log = (await ctx.rest.getSupervisorLog("core")).replace(ANSI, "");
					} catch {
						return errorResult(
							"This Home Assistant has no error log file (/api/error_log is 404) and no Supervisor core log " +
								"to read instead. Use ha_get_system_log."
						);
					}
				}
				return textResult(tail(log, tail_lines ?? DEFAULT_TAIL_LINES) || "(error log is empty)");
			})
	);

	server.registerTool(
		"ha_get_supervisor_log",
		{
			title: "Get Supervisor / add-on log",
			description:
				"Tail the logs of an add-on, Home Assistant Core, the Supervisor itself, or the host — for problems that never reach HA's own error log (an add-on crash-looping, a failed install, host-level trouble). Requires a Supervised / HAOS install. Works through the VomeHome broker too (read scope).",
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
				let log: string;
				try {
					log = await ctx.rest.getSupervisorLog(source, addon_slug);
				} catch (error) {
					if (error instanceof HaApiError && error.status === 404) {
						return errorResult(
							source === "addon"
								? `No add-on '${addon_slug}' here, or no Supervisor (Core/Container installs have none). List add-ons with ha_supervisor_api /addons.`
								: "No Supervisor on this Home Assistant — Core/Container installs have none, so there is no Supervisor log to read."
						);
					}
					throw error;
				}
				const text = tail(log, tail_lines ?? DEFAULT_TAIL_LINES);
				return textResult(text || `(${source} log is empty)`);
			})
	);

	server.registerTool(
		"ha_get_logbook",
		{
			title: "Get logbook",
			description:
				"Return human-readable logbook entries (what happened and when), optionally filtered to a single entity and time window. " +
				"Times are ISO 8601; with a start_time and no end_time it runs up to now (Home Assistant on its own would stop 24 hours after the start). " +
					`A window longer than a day is read a day at a time, newest first, stopping once 'limit' entries match (at most ${MAX_LOGBOOK_CHUNKS} days per call). ` +
				`A busy home logs tens of thousands of entries a night, so filter with contains / name / domain, and at most 'limit' (default ${DEFAULT_LOGBOOK_LIMIT}) entries come back: ` +
				"the newest ones, in time order. When more matched, truncated is true and older_entries_end_time says where to continue (pass it as end_time).",
			inputSchema: {
				entity_id: z.string().optional().describe("Restrict to a single entity_id (filtered by Home Assistant itself)."),
				start_time: z.string().optional().describe("ISO 8601 start timestamp."),
				end_time: z.string().optional().describe("ISO 8601 end timestamp."),
				contains: z
					.string()
					.optional()
					.describe("Case-insensitive substring matched against the entry's message, name and entity_id."),
				name: z
					.string()
					.optional()
					.describe("Only entries with exactly this logbook name, case-insensitive, e.g. 'Vome' or 'Kitchen light'."),
				domain: z
					.string()
					.optional()
					.describe("Only entries from this domain, e.g. 'automation' or 'light' (the entry's domain, else its entity_id's)."),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(`Maximum entries to return, the newest ones (default ${DEFAULT_LOGBOOK_LIMIT}).`)
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ entity_id, start_time, end_time, contains, name, domain, limit }) =>
			runTool(ctx.logger, "ha_get_logbook", async () => {
				// Same 24-hour default as history; see ha_get_history.
				const end = end_time ?? (start_time ? new Date().toISOString() : undefined);
				const plan = start_time && end ? logbookChunks(start_time, end) : null;
				const chunks: LogbookChunk[] = plan?.chunks ?? [{ startTime: start_time, endTime: end }];
				const filters = { contains, name, domain };
				const max = Math.max(1, limit ?? DEFAULT_LOGBOOK_LIMIT);
				// Newest read first; each read's matches in time order.
				const reads: HaLogbookEntry[][] = [];
				const untimed = new Set<string>();
				let fetchedCount = 0;
				let matchedCount = 0;
				let stoppedEarly = false;
				for (const [index, chunk] of chunks.entries()) {
					const fetched = await ctx.rest.getLogbook({
						entityId: entity_id,
						startTime: chunk.startTime,
						endTime: chunk.endTime
					});
					const own = ownEntries(Array.isArray(fetched) ? fetched : [], chunk, untimed);
					fetchedCount += own.length;
					const matches = inTimeOrder(own.filter((entry) => matchesLogbookFilters(entry, filters)));
					reads.push(matches);
					matchedCount += matches.length;
					if (matchedCount >= max && index < chunks.length - 1) {
						stoppedEarly = true;
						break;
					}
				}
				const matched = reads.reverse().flat();
				// Keep the newest: "what just happened" is the usual question, and
				// older_entries_end_time lets the caller walk back from there.
				const entries = matched.length > max ? matched.slice(matched.length - max) : matched;
				const leftOut = matched.length - entries.length;
				const notRead = stoppedEarly || plan?.skippedBefore !== undefined;
				const truncated = leftOut > 0 || notRead;
				const oldestTime = logbookTime(entries[0]?.when);
				const oldestKept = Number.isNaN(oldestTime) ? undefined : new Date(oldestTime).toISOString();
				const continueAt =
					leftOut > 0 || stoppedEarly ? (oldestKept ?? null) : (plan?.skippedBefore ?? oldestKept ?? null);
				const notes: string[] = [];
				if (leftOut > 0) notes.push(`${leftOut} older matching entries were left out.`);
				if (stoppedEarly) {
					notes.push(
						`Stopped after ${reads.length} of ${chunks.length} day-sized reads with ${max} matching entries; ` +
							"earlier days were not read and may hold more."
					);
				} else if (plan?.skippedBefore) {
					notes.push(
						`The window is longer than ${MAX_LOGBOOK_CHUNKS} days, so only the newest ${MAX_LOGBOOK_CHUNKS} ` +
							`day-sized reads were made; nothing before ${plan.skippedBefore} was read.`
					);
				}
				return jsonResult({
					count: entries.length,
					count_before_limit: matched.length,
					fetched: fetchedCount,
					...(chunks.length > 1 ? { requests: reads.length } : {}),
					truncated,
					filters: {
						entity_id: entity_id ?? null,
						contains: contains ?? null,
						name: name ?? null,
						domain: domain ?? null
					},
					...(truncated
						? {
								older_entries_end_time: continueAt,
								note:
									`${notes.join(" ")} Narrow the window or the filters, or call again with end_time set to ` +
									"older_entries_end_time to read further back."
							}
						: {}),
					entries
				});
			})
	);
}

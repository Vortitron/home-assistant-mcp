import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EsphomeStreamCommand } from "../esphome/client.js";
import { evaluateConfigWrite } from "../safety.js";
import { summariseOutput } from "../esphome/summary.js";
import { buildProgressFor, type ProgressExtra } from "../esphome/progress.js";
import { errorResult, jsonResult, runTool, textResult, type ToolContext } from "./helpers.js";
import { readLocalUpload, restFileWriteUrl } from "./configFiles.js";

const SECONDS_TO_MS = 1000;
/** Lines kept from the end of a long build's output, and of a long log read. */
const BUILD_TAIL = 60;
const LOG_TAIL = 200;

/**
 * Shared tail for the streaming build commands.
 *
 * These run over the VomeHome relay, so in normal use they simply work and the
 * description says so. That wording is deliberate: told "not available in
 * brokered mode", models concluded the feature did not exist and reported that
 * to users, when the capability was there the whole time.
 */
const STREAM_AVAILABILITY =
	" Runs over the VomeHome relay — no ports to open. If a call reports that ESPHome is " +
	"unreachable, run esphome_dashboard_info to see why rather than telling the user this " +
	"is unsupported.";

/**
 * Configuration filenames the dashboard flagged as needing a rename.
 *
 * Tolerant of shape: the listing is the dashboard's own model and has changed
 * before, so a missing or unexpected field means "nothing to report" rather
 * than an error in an unrelated tool.
 */
function pendingMigrationConfigs(devices: unknown): string[] {
	const rows =
		devices && typeof devices === "object" && Array.isArray((devices as { configured?: unknown }).configured)
			? (devices as { configured: unknown[] }).configured
			: Array.isArray(devices)
				? devices
				: [];
	const out: string[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const entry = row as { migration_available?: unknown; configuration?: unknown };
		if (entry.migration_available === true && typeof entry.configuration === "string") {
			out.push(entry.configuration);
		}
	}
	return out;
}

/** Rows esphome_list_devices returns unless asked for more, and its ceiling. */
const DEVICE_LIST_DEFAULT = 50;
const DEVICE_LIST_MAX = 500;

/** The fields a filter looks in: what an agent knows a device by. */
const DEVICE_SEARCH_FIELDS = ["name", "friendly_name", "configuration", "address", "ip", "ip_addresses"] as const;

/**
 * The fields of a compact row, in order. Device Builder's own row runs to
 * some fifty fields (integration lists, hashes, MACs, partition flags), about
 * eighty lines of JSON per device, so a home with a dozen devices answered
 * "which file is the kitchen detector" with a thousand lines.
 */
const DEVICE_COMPACT_FIELDS = [
	"name",
	"friendly_name",
	"configuration",
	"address",
	"ip",
	"area",
	"target_platform",
	"deployed_version",
	"current_version",
	"state",
	"update_available",
	"has_pending_changes",
	"migration_available"
] as const;

function deviceRows(devices: unknown): { configured: unknown[]; importable: unknown[] } {
	if (Array.isArray(devices)) return { configured: devices, importable: [] };
	if (!devices || typeof devices !== "object") return { configured: [], importable: [] };
	const shaped = devices as { configured?: unknown; importable?: unknown };
	return {
		configured: Array.isArray(shaped.configured) ? shaped.configured : [],
		importable: Array.isArray(shaped.importable) ? shaped.importable : []
	};
}

/** Case-insensitive substring match over the fields a device is known by. */
function deviceMatches(row: unknown, needle: string): boolean {
	if (!needle) return true;
	if (!row || typeof row !== "object") return false;
	const entry = row as Record<string, unknown>;
	return DEVICE_SEARCH_FIELDS.some((field) => {
		const value = entry[field];
		const values = Array.isArray(value) ? value : [value];
		return values.some((v) => (typeof v === "string" || typeof v === "number") && String(v).toLowerCase().includes(needle));
	});
}

/** A row cut to the fields that identify a device and say how it is doing; empty values left out. */
function compactDevice(row: unknown): unknown {
	if (!row || typeof row !== "object") return row;
	const entry = row as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const field of DEVICE_COMPACT_FIELDS) {
		const value = entry[field];
		if (value === undefined || value === null || value === "") continue;
		// Only worth a line when it is set.
		if (field === "migration_available" && value !== true) continue;
		out[field] = value;
	}
	if (out.ip === undefined && Array.isArray(entry.ip_addresses) && entry.ip_addresses.length > 0) {
		out.ip_addresses = entry.ip_addresses;
	}
	return out;
}

/**
 * What esphome_save_config says on the hosted server when given yaml_path.
 *
 * There "local" is Vome's machine, not the agent's, so the file is never
 * looked for. The routes that do work from there: send the file over the
 * REST file write into esphome/ (where the ESPHome add-on keeps its configs)
 * from the machine that has it, or keep to esphome_edit_config with edits
 * small enough to send inline.
 */
export function hostedYamlPathMessage(apiUrl: string, instanceId: string, configuration: string, yamlPath: string): string {
	const url = restFileWriteUrl(apiUrl, instanceId, `esphome/${configuration}`);
	return [
		"Nothing saved: this is the hosted Vome MCP. It runs on Vome's servers, so it cannot see files on " +
			"your machine, and yaml_path is only read on the machine the MCP runs on.",
		"",
		"Either send the file over the Vome REST API from the machine that has it (the API key needs ha:files). " +
			"It lands in the config directory at esphome/" +
			configuration +
			", where the ESPHome add-on keeps its configurations:",
		"",
		`  curl -X POST "${url}" \\`,
		'    -H "Authorization: Bearer $VOMEHOME_TOKEN" \\',
		`    -F "file=@${yamlPath}"`,
		"",
		"Writing a .yaml file this way needs the Vome app (add-on) on the home; the integration alone does not " +
			"write YAML. It also skips the ESPHome dashboard, so run esphome_validate on it afterwards.",
		"",
		"Or, for a change to an existing file, use esphome_edit_config with smaller edits, sent as several " +
			"calls if need be. Each edit only has to quote the text it changes."
	].join("\n");
}

export function registerEsphomeTools(server: McpServer, ctx: ToolContext): void {
	const runStream = async (
		command: EsphomeStreamCommand,
		configuration: string,
		options: { port?: string; timeoutSeconds?: number; openEnded?: boolean; fullOutput?: boolean; extra?: ProgressExtra } = {}
	) => {
		const result = await ctx.esphome.runCommand({
			command,
			configuration,
			onProgress: buildProgressFor(options.extra),
			port: options.port,
			timeoutMs: options.timeoutSeconds ? options.timeoutSeconds * SECONDS_TO_MS : undefined
		});
		// `logs` has no natural end — it runs until the caller stops watching,
		// so reaching the timeout is how it is *supposed* to finish. Reporting
		// that as success:false told agents a log read had failed when it had
		// done exactly what was asked.
		const stoppedByTimeout = result.timedOut === true;
		const success = stoppedByTimeout ? options.openEnded === true : result.exitCode === 0;
		// A log read keeps more of its end: the recent lines are what was asked to be watched.
		const summary = options.fullOutput
			? null
			: summariseOutput(result.output, command === "logs" ? LOG_TAIL : BUILD_TAIL);
		return jsonResult({
			command: result.command,
			configuration: result.configuration,
			exit_code: result.exitCode,
			success,
			stopped: stoppedByTimeout ? "timeout" : "completed",
			truncated: result.truncated,
			output: summary ? summary.output : result.output,
			...(summary?.summarised ? { output_lines: summary.total_lines, output_summarised: true } : {}),
			...(stoppedByTimeout && options.openEnded
				? {
						note:
							"Streaming ran for the full timeout and was stopped. That is the normal " +
							"end of a log stream, not a failure; raise timeout_seconds to watch longer."
					}
				: {})
		});
	};

	server.registerTool(
		"esphome_dashboard_info",
		{
			title: "Check ESPHome capability",
			description:
				"Report whether ESPHome is reachable and what is possible right now — listing and " +
				"editing configs, and the streaming commands (validate/compile/upload/logs/clean). " +
				"ESPHome is reached through a VomeHome relay-connected Home Assistant running the " +
				"Vome add-on; when that is in place everything is available. Call this before telling " +
				"a user that flashing or log-reading is unsupported — it usually is not.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "esphome_dashboard_info", async () => {
				const status = await ctx.esphome.describe();
				return jsonResult({
					mode: status.mode,
					streaming_commands_available: status.streaming,
					can_flash: status.streaming,
					can_read_device_logs: status.streaming,
					can_list_and_edit_yaml: status.mode === "brokered",
					instance: status.instance,
					note: status.note
				});
			})
	);

	server.registerTool(
		"esphome_activity",
		{
			title: "ESPHome build activity",
			description:
				"What the ESPHome build commands (validate, compile, upload, logs) started in this session are doing: " +
				"each running or recently finished job with its newest output lines. Pass back the returned 'seq' as " +
				"'since' to get only lines produced after it. For watching a long build while it runs; the build " +
				"tools themselves return the full output when they finish.",
			inputSchema: {
				since: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe("Return only output lines newer than this sequence number (the 'seq' of an earlier call).")
			},
			annotations: { readOnlyHint: true, openWorldHint: false }
		},
		async ({ since }) => runTool(ctx.logger, "esphome_activity", async () => jsonResult(ctx.esphome.activity(since)))
	);

	server.registerTool(
		"esphome_list_devices",
		{
			title: "List ESPHome devices",
			description:
				"List devices/configurations known to the ESPHome dashboard, including their configuration filenames " +
				"(needed by the other ESPHome tools). Each device comes back as a compact row (name, friendly_name, " +
				"configuration, address/ip, area, platform, deployed/current version, state, update and pending-change " +
				"flags); full=true returns the dashboard's own rows, which run to about 80 lines a device. 'filter' " +
				"narrows to devices whose name, friendly name, configuration filename or address/ip contains it " +
				"(case-insensitive). The reply gives total, matched and truncated, and flags configs needing renames.",
			inputSchema: {
				filter: z
					.string()
					.optional()
					.describe("Only devices whose name, friendly name, configuration filename or address/ip contains this (case-insensitive), e.g. 'kitchen'."),
				limit: z
					.number()
					.int()
					.positive()
					.max(DEVICE_LIST_MAX)
					.optional()
					.describe(`Devices to return at most (default ${DEVICE_LIST_DEFAULT}, max ${DEVICE_LIST_MAX}).`),
				full: z
					.boolean()
					.optional()
					.describe("Return the dashboard's full row for each device instead of the compact one.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ filter, limit, full }) =>
			runTool(ctx.logger, "esphome_list_devices", async () => {
				const rows = deviceRows(await ctx.esphome.listDevices());
				const needle = (filter ?? "").trim().toLowerCase();
				const cap = limit ?? DEVICE_LIST_DEFAULT;
				const matched = rows.configured.filter((row) => deviceMatches(row, needle));
				const shown = matched.slice(0, cap);
				const importable = rows.importable.filter((row) => deviceMatches(row, needle));
				// ESPHome shows a "Config migration available" banner in its own
				// UI; nothing surfaces it to an agent, so deprecated spellings
				// get carried forward until a release drops them. The flag is
				// already in each row — this lifts it where it will be read.
				const pending = pendingMigrationConfigs(matched);
				const truncated = matched.length > shown.length;
				return jsonResult({
					total: rows.configured.length,
					matched: matched.length,
					truncated,
					...(needle ? { filter: filter?.trim() } : {}),
					devices: full ? shown : shown.map(compactDevice),
					...(importable.length > 0 ? { importable } : {}),
					...(truncated
						? {
								note:
									`Showing ${shown.length} of ${matched.length} matching devices. Narrow with 'filter' ` +
									`(a name or filename), or raise 'limit' (max ${DEVICE_LIST_MAX}).`
							}
						: {}),
					...(pending.length > 0
						? {
								configs_with_pending_migrations: pending,
								migration_hint:
									"These configs use ESPHome spellings that have been renamed. " +
									"Call esphome_list_migrations on one to see the exact renames."
							}
						: {})
				});
			})
	);

	server.registerTool(
		"esphome_get_config",
		{
			title: "Get ESPHome config",
			description:
				"Read the YAML for an ESPHome configuration file (e.g. 'living-room.yaml').",
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ configuration }) =>
			runTool(ctx.logger, "esphome_get_config", async () => {
				const yaml = await ctx.esphome.getConfig(configuration);
				return textResult(yaml);
			})
	);

	server.registerTool(
		"esphome_list_migrations",
		{
			title: "Check a config for ESPHome renames",
			description:
				"Report the ESPHome spellings a device's YAML still uses that have since been " +
				"renamed — the same 'Config migration available' notice the ESPHome dashboard shows " +
				"in its own UI, which is otherwise invisible from here. Each entry names the old and " +
				"new spelling and the ESPHome release that changed it.\n\n" +
				"`required: true` means the installed ESPHome already rejects the old spelling, so the " +
				"config will fail to compile until it is fixed; otherwise it still works but is on " +
				"borrowed time. Apply a rename by editing the YAML with esphome_save_config.",
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ configuration }) =>
			runTool(ctx.logger, "esphome_list_migrations", async () => {
				const report = await ctx.esphome.getMigrations(configuration);
				return jsonResult(report);
			})
	);

	server.registerTool(
		"esphome_save_config",
		{
			title: "Save ESPHome config",
			description:
				"Write YAML to an ESPHome configuration file, whole: for a new file, or a rewrite too large to send " +
				"as edits. Give the YAML inline as 'yaml', or as 'yaml_path', a file on the MCP server's machine " +
				"(npx / stdio only; UTF-8 text, at most 2 MiB), so a long config is never pasted into the call. " +
				"Both are saved the same way. The hosted Vome MCP cannot read your disk: there yaml_path reads nothing " +
				"and the reply gives the REST upload to run instead. To change part of an existing file, use " +
				"esphome_edit_config. Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true. Follow with " +
				"esphome_validate to confirm it compiles, then esphome_upload to flash it.",
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'."),
				yaml: z.string().optional().describe("Full YAML content to write. Give this or yaml_path, not both."),
				yaml_path: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Instead of 'yaml': a YAML file on the MCP server's machine (absolute, '~/...', or relative to the " +
							"server's working directory), sent as the whole new config. UTF-8 text, at most 2 MiB. Not on " +
							"the hosted Vome MCP."
					)
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ configuration, yaml, yaml_path }) =>
			runTool(ctx.logger, "esphome_save_config", async () => {
				const fromPath = typeof yaml_path === "string" && yaml_path.trim() !== "";
				if ((typeof yaml === "string") === fromPath) {
					return errorResult(
						"Nothing saved: give exactly one of 'yaml' (the YAML itself) or 'yaml_path' (a file on the MCP " +
							"server's machine)."
					);
				}
				// Per-instance config policy (matches the active HA instance).
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				if (!fromPath) {
					await ctx.esphome.saveConfig(configuration, yaml as string);
					return jsonResult({ saved: true, configuration });
				}
				// On the hosted server "local" is Vome's disk. Never read it.
				if (ctx.config.hosted) {
					return errorResult(
						hostedYamlPathMessage(ctx.config.vomehome.apiUrl, ctx.instances.activeId(), configuration, yaml_path)
					);
				}
				const local = await readLocalUpload(yaml_path, process.cwd(), { lead: "Nothing saved", argName: "yaml_path" });
				if (!local.ok) {
					return errorResult(local.message);
				}
				if (local.encoding !== "utf8") {
					return errorResult(
						`Nothing saved: ${local.resolved} is not UTF-8 text (it reads as binary), so it cannot be ESPHome YAML.`
					);
				}
				// The same dashboard write as inline yaml, so validation and behaviour are identical.
				await ctx.esphome.saveConfig(configuration, local.content);
				return jsonResult({ saved: true, configuration, read_from: local.resolved, bytes: local.bytes });
			})
	);

	server.registerTool(
		"esphome_edit_config",
		{
			title: "Edit ESPHome config",
			description:
				"Change part of an ESPHome configuration file in place: each edit replaces one exact piece of " +
				"text with another, and must match exactly once. Prefer this to esphome_save_config for any " +
				"change to an existing file: a real device's YAML runs to thousands of lines, and resending all " +
				"of it to change a few is slow and risks a slip anywhere in it. Nothing is saved unless every " +
				"edit applies. For a large rewrite, don't send huge edits: on a local MCP (npx / stdio) write the " +
				"file and use esphome_save_config with yaml_path. Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true. Follow with " +
				"esphome_validate, then esphome_upload to flash it.",
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'."),
				edits: z
					.array(
						z.object({
							old_text: z.string().min(1).describe("Text in the file now, exactly, including indentation. Must occur once."),
							new_text: z.string().describe("What it becomes.")
						})
					)
					.min(1)
					.describe("Applied in order, each to the result of the one before.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ configuration, edits }) =>
			runTool(ctx.logger, "esphome_edit_config", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const before = await ctx.esphome.getConfig(configuration);
				let yaml = before;
				for (const [index, edit] of edits.entries()) {
					const at = yaml.indexOf(edit.old_text);
					const again = at < 0 ? -1 : yaml.indexOf(edit.old_text, at + 1);
					if (at < 0 || again >= 0) {
						return errorResult(
							`Nothing saved: edit ${index + 1} of ${edits.length} ${at < 0 ? "matches nothing" : "matches more than once"} ` +
								`in ${configuration}. Quote more of the surrounding text so it matches exactly once.`
						);
					}
					yaml = yaml.slice(0, at) + edit.new_text + yaml.slice(at + edit.old_text.length);
				}
				await ctx.esphome.saveConfig(configuration, yaml);
				const count = (text: string) => text.split("\n").length;
				return jsonResult({
					saved: true,
					configuration,
					edits_applied: edits.length,
					lines_before: count(before),
					lines_after: count(yaml)
				});
			})
	);

	server.registerTool(
		"esphome_validate",
		{
			title: "Validate ESPHome config",
			description:
				"Validate (compile-check) an ESPHome configuration and return the output. The fast way to confirm a YAML edit is correct before compiling or flashing." +
				STREAM_AVAILABILITY,
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'."),
				timeout_seconds: z.number().int().positive().optional().describe("Override the command timeout."),
				full_output: z
					.boolean()
					.optional()
					.describe("Return every line of output. By default a long output comes back summarised: all errors and warnings, memory use, and the last lines.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ configuration, timeout_seconds, full_output }, extra) =>
			runTool(ctx.logger, "esphome_validate", async () =>
				runStream("validate", configuration, { timeoutSeconds: timeout_seconds, fullOutput: full_output, extra })
			)
	);

	server.registerTool(
		"esphome_compile",
		{
			title: "Compile ESPHome firmware",
			description:
				"Compile firmware for an ESPHome configuration and return the build output. Can take several minutes." +
				STREAM_AVAILABILITY,
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'."),
				timeout_seconds: z.number().int().positive().optional().describe("Override the command timeout."),
				full_output: z
					.boolean()
					.optional()
					.describe("Return every line of output. By default a long output comes back summarised: all errors and warnings, memory use, and the last lines.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ configuration, timeout_seconds, full_output }, extra) =>
			runTool(ctx.logger, "esphome_compile", async () =>
				runStream("compile", configuration, { timeoutSeconds: timeout_seconds, fullOutput: full_output, extra })
			)
	);

	server.registerTool(
		"esphome_upload",
		{
			title: "Flash ESPHome firmware (OTA)",
			description:
				"Compile and flash firmware to a device over the air. This is how you update an ESPHome device — no cable, no manual step in the ESPHome UI. 'port' is the device address or 'OTA' (the default). Requires write access." +
				" The build runs first and a failed build never reaches the device." +
				STREAM_AVAILABILITY,
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'."),
				port: z.string().optional().describe("Device address (IP/hostname) or 'OTA'. Defaults to 'OTA'."),
				timeout_seconds: z.number().int().positive().optional().describe("Override the command timeout."),
				full_output: z
					.boolean()
					.optional()
					.describe("Return every line of output. By default a long output comes back summarised: all errors and warnings, memory use, and the last lines.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ configuration, port, timeout_seconds, full_output }, extra) =>
			runTool(ctx.logger, "esphome_upload", async () => {
				if (!ctx.instances.currentSafety().allowWrite) {
					return errorResult(
						"Refused: flashing firmware requires write access for the active instance."
					);
				}
				// Device Builder's `firmware/upload` only sends a firmware that is already built
				// (its own Install button queues a compile, then an upload). Flashing a config
				// with no fresh build failed with "No such file .../<name>.bin" (GamlaBio's
				// LoftC3, 2 Oct 2026), or would send a stale one. So compile first here; a build
				// that fails never reaches the device.
				const progress = buildProgressFor(extra);
				const timeoutMs = timeout_seconds ? timeout_seconds * SECONDS_TO_MS : undefined;
				const built = await ctx.esphome.runCommand({ command: "compile", configuration, onProgress: progress, timeoutMs });
				if (built.exitCode !== 0 || built.timedOut) {
					const summary = full_output ? null : summariseOutput(built.output, BUILD_TAIL);
					return jsonResult({
						command: "upload",
						configuration,
						exit_code: built.exitCode,
						success: false,
						stopped: built.timedOut ? "timeout" : "completed",
						failed_step: "compile",
						note: "The build failed, so nothing was sent to the device.",
						truncated: built.truncated,
						output: summary ? summary.output : built.output,
						...(summary?.summarised ? { output_lines: summary.total_lines, output_summarised: true } : {})
					});
				}
				const sent = await ctx.esphome.runCommand({ command: "upload", configuration, port: port ?? "OTA", onProgress: progress, timeoutMs });
				const both = `${built.output}${built.output.endsWith("\n") ? "" : "\n"}${sent.output}`;
				const summary = full_output ? null : summariseOutput(both, BUILD_TAIL);
				return jsonResult({
					command: "upload",
					configuration,
					exit_code: sent.exitCode,
					success: sent.exitCode === 0 && !sent.timedOut,
					stopped: sent.timedOut ? "timeout" : "completed",
					...(sent.exitCode !== 0 ? { failed_step: "upload" } : {}),
					truncated: built.truncated || sent.truncated,
					output: summary ? summary.output : both,
					...(summary?.summarised ? { output_lines: summary.total_lines, output_summarised: true } : {})
				});
			})
	);

	server.registerTool(
		"esphome_logs",
		{
			title: "Read ESPHome device logs",
			description:
				"Stream the live logs from an ESPHome device and return what was captured. This is the way to " +
				"see what a device is actually doing — boot messages, wifi/API connection problems, sensor " +
				"readings, crashes and reboot reasons. Use it after flashing, or whenever a device is behaving " +
				"oddly. Returns once the timeout elapses, so set timeout_seconds to how long you want to watch." +
				STREAM_AVAILABILITY,
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'."),
				port: z
					.string()
					.optional()
					.describe("Device address (IP/hostname) or 'OTA' for logs over the network. Defaults to 'OTA'."),
				timeout_seconds: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("How long to capture logs for. Defaults to the standard command timeout."),
				full_output: z
					.boolean()
					.optional()
					.describe("Return every line of output. By default a long output comes back summarised: all errors and warnings, memory use, and the last lines.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ configuration, port, timeout_seconds, full_output }, extra) =>
			runTool(ctx.logger, "esphome_logs", async () =>
				runStream("logs", configuration, {
					port: port ?? "OTA",
					timeoutSeconds: timeout_seconds,
					openEnded: true,
					fullOutput: full_output,
					extra
				})
			)
	);

	server.registerTool(
		"esphome_clean",
		{
			title: "Clean ESPHome build files",
			description:
				"Delete the cached build files for a configuration. Use this when a compile fails for reasons " +
				"the YAML does not explain — a stale build directory after an ESPHome version change is the " +
				"usual cause. Then compile again." +
				STREAM_AVAILABILITY,
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'."),
				timeout_seconds: z.number().int().positive().optional().describe("Override the command timeout.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ configuration, timeout_seconds }) =>
			runTool(ctx.logger, "esphome_clean", async () => {
				if (!ctx.instances.currentSafety().allowWrite) {
					return errorResult(
						"Refused: cleaning build files requires write access for the active instance."
					);
				}
				return runStream("clean", configuration, { timeoutSeconds: timeout_seconds });
			})
	);
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EsphomeStreamCommand } from "../esphome/client.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, textResult, type ToolContext } from "./helpers.js";

const SECONDS_TO_MS = 1000;

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

export function registerEsphomeTools(server: McpServer, ctx: ToolContext): void {
	const runStream = async (
		command: EsphomeStreamCommand,
		configuration: string,
		options: { port?: string; timeoutSeconds?: number; openEnded?: boolean } = {}
	) => {
		const result = await ctx.esphome.runCommand({
			command,
			configuration,
			port: options.port,
			timeoutMs: options.timeoutSeconds ? options.timeoutSeconds * SECONDS_TO_MS : undefined
		});
		// `logs` has no natural end — it runs until the caller stops watching,
		// so reaching the timeout is how it is *supposed* to finish. Reporting
		// that as success:false told agents a log read had failed when it had
		// done exactly what was asked.
		const stoppedByTimeout = result.timedOut === true;
		const success = stoppedByTimeout ? options.openEnded === true : result.exitCode === 0;
		return jsonResult({
			command: result.command,
			configuration: result.configuration,
			exit_code: result.exitCode,
			success,
			stopped: stoppedByTimeout ? "timeout" : "completed",
			truncated: result.truncated,
			output: result.output,
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
		"esphome_list_devices",
		{
			title: "List ESPHome devices",
			description:
				"List devices/configurations known to the ESPHome dashboard, including their configuration filenames (needed by the other ESPHome tools).",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "esphome_list_devices", async () => {
				const devices = await ctx.esphome.listDevices();
				// ESPHome shows a "Config migration available" banner in its own
				// UI; nothing surfaces it to an agent, so deprecated spellings
				// get carried forward until a release drops them. The flag is
				// already in each row — this lifts it where it will be read.
				const pending = pendingMigrationConfigs(devices);
				return jsonResult(
					pending.length > 0
						? {
								devices,
								configs_with_pending_migrations: pending,
								migration_hint:
									"These configs use ESPHome spellings that have been renamed. " +
									"Call esphome_list_migrations on one to see the exact renames."
							}
						: devices
				);
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
				"Write YAML to an ESPHome configuration file. Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true. Follow with esphome_validate to confirm it compiles, then esphome_upload to flash it.",
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'."),
				yaml: z.string().describe("Full YAML content to write.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ configuration, yaml }) =>
			runTool(ctx.logger, "esphome_save_config", async () => {
				// Per-instance config policy (matches the active HA instance).
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				await ctx.esphome.saveConfig(configuration, yaml);
				return jsonResult({ saved: true, configuration });
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
				timeout_seconds: z.number().int().positive().optional().describe("Override the command timeout.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ configuration, timeout_seconds }) =>
			runTool(ctx.logger, "esphome_validate", async () =>
				runStream("validate", configuration, { timeoutSeconds: timeout_seconds })
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
				timeout_seconds: z.number().int().positive().optional().describe("Override the command timeout.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ configuration, timeout_seconds }) =>
			runTool(ctx.logger, "esphome_compile", async () =>
				runStream("compile", configuration, { timeoutSeconds: timeout_seconds })
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
				timeout_seconds: z.number().int().positive().optional().describe("Override the command timeout.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ configuration, port, timeout_seconds }) =>
			runTool(ctx.logger, "esphome_upload", async () => {
				if (!ctx.instances.currentSafety().allowWrite) {
					return errorResult(
						"Refused: flashing firmware requires write access for the active instance."
					);
				}
				// This used to pre-flight with `validate`, which was actively
				// harmful: ESPHome Device Builder removed that endpoint, so the
				// check failed on every current dashboard and took every flash
				// with it. No safety was lost — `upload` compiles first and a
				// failed build never reaches the device.
				return runStream("upload", configuration, {
					port: port ?? "OTA",
					timeoutSeconds: timeout_seconds
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
					.describe("How long to capture logs for. Defaults to the standard command timeout.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ configuration, port, timeout_seconds }) =>
			runTool(ctx.logger, "esphome_logs", async () =>
				runStream("logs", configuration, {
					port: port ?? "OTA",
					timeoutSeconds: timeout_seconds,
					openEnded: true
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

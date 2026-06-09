import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EsphomeStreamCommand } from "../esphome/dashboardClient.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, textResult, type ToolContext } from "./helpers.js";

const SECONDS_TO_MS = 1000;

export function registerEsphomeTools(server: McpServer, ctx: ToolContext): void {
	const runStream = async (
		command: EsphomeStreamCommand,
		configuration: string,
		options: { port?: string; timeoutSeconds?: number } = {}
	) => {
		const result = await ctx.esphome.runCommand({
			command,
			configuration,
			port: options.port,
			timeoutMs: options.timeoutSeconds ? options.timeoutSeconds * SECONDS_TO_MS : undefined
		});
		return jsonResult({
			command: result.command,
			configuration: result.configuration,
			exit_code: result.exitCode,
			success: result.exitCode === 0,
			truncated: result.truncated,
			output: result.output
		});
	};

	server.registerTool(
		"esphome_list_devices",
		{
			title: "List ESPHome devices",
			description:
				"List devices/configurations known to the ESPHome dashboard, including their configuration filenames (needed by the other ESPHome tools). Works with a direct ESPHOME_DASHBOARD_URL or in VomeHome brokered mode.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "esphome_list_devices", async () => {
				const devices = await ctx.esphome.listDevices();
				return jsonResult(devices);
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
		"esphome_save_config",
		{
			title: "Save ESPHome config",
			description:
				"Write YAML to an ESPHome configuration file. Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true. Follow with esphome_validate to confirm it compiles.",
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'."),
				yaml: z.string().describe("Full YAML content to write.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ configuration, yaml }) =>
			runTool(ctx.logger, "esphome_save_config", async () => {
				const decision = evaluateConfigWrite(ctx.config.safety);
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
				"Validate (compile-check the config of) an ESPHome configuration and return the output. Fast way to confirm a YAML edit is correct before compiling/flashing. Streams output, so needs a direct ESPHOME_DASHBOARD_URL (not available in VomeHome brokered mode). Works on dashboards without a dashboard password.",
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
				"Compile firmware for an ESPHome configuration and return the build output. Can take several minutes. Streams output, so needs a direct ESPHOME_DASHBOARD_URL (not available in VomeHome brokered mode). Works on dashboards without a dashboard password.",
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
			title: "Upload/flash ESPHome firmware",
			description:
				"Compile and upload firmware to a device (OTA by default). 'port' is the device address or 'OTA'. Requires HA_ALLOW_WRITE=true. Streams output, so needs a direct ESPHOME_DASHBOARD_URL (not available in VomeHome brokered mode). Works on dashboards without a dashboard password.",
			inputSchema: {
				configuration: z.string().describe("Configuration filename, e.g. 'living-room.yaml'."),
				port: z.string().optional().describe("Device address (IP/hostname) or 'OTA'. Defaults to 'OTA'."),
				timeout_seconds: z.number().int().positive().optional().describe("Override the command timeout.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ configuration, port, timeout_seconds }) =>
			runTool(ctx.logger, "esphome_upload", async () => {
				if (!ctx.config.safety.allowWrite) {
					return errorResult("Refused: uploading firmware requires HA_ALLOW_WRITE=true.");
				}
				return runStream("upload", configuration, {
					port: port ?? "OTA",
					timeoutSeconds: timeout_seconds
				});
			})
	);
}

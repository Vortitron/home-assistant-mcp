#!/usr/bin/env node
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, validateConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createHaRestClient } from "./ha/restClient.js";
import { createHaWsClient } from "./ha/wsClient.js";
import { createEsphomeDashboardClient } from "./esphome/dashboardClient.js";
import { registerAllTools } from "./tools/index.js";
import type { ToolContext } from "./tools/helpers.js";
import { runDoctor } from "./cli/doctor.js";

const SERVER_NAME = "home-assistant-mcp";
const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
	dotenv.config();
	const config = loadConfig(process.env);
	const logger = createLogger(config.logLevel);
	const command = process.argv[2];

	if (command === "doctor") {
		const exitCode = await runDoctor(config, logger);
		process.exit(exitCode);
	}

	const problems = validateConfig(config);
	if (problems.length > 0) {
		for (const problem of problems) {
			logger.error(`Config ${problem.field}: ${problem.message}`);
		}
		logger.error(
			"Refusing to start. Set the required environment variables (see .env.example), then run 'home-assistant-mcp doctor' to verify connectivity."
		);
		process.exit(1);
	}

	const rest = createHaRestClient(config, logger);
	const ws = createHaWsClient(config, logger);
	const esphome = createEsphomeDashboardClient(config, logger);
	const ctx: ToolContext = { config, logger, rest, ws, esphome };

	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	registerAllTools(server, ctx);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	logger.info(
		`${SERVER_NAME} v${SERVER_VERSION} ready (writes ${config.safety.allowWrite ? "ENABLED" : "disabled"}, esphome ${config.esphome.enabled ? "enabled" : "disabled"})`
	);

	const shutdown = (signal: string): void => {
		logger.info(`Received ${signal}, shutting down`);
		void ws
			.close()
			.catch(() => undefined)
			.then(() => server.close())
			.catch(() => undefined)
			.finally(() => process.exit(0));
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
	process.stderr.write(
		`Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
	);
	process.exit(1);
});

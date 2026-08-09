#!/usr/bin/env node
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, validateConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createToolContext, describeMode } from "./context.js";
import { registerAllTools } from "./tools/index.js";
import { runDoctor } from "./cli/doctor.js";
import { runTunnel } from "./cli/tunnel.js";
import { runServe } from "./cli/serve.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

async function main(): Promise<void> {
	dotenv.config();
	const config = loadConfig(process.env);
	const logger = createLogger(config.logLevel);
	const command = process.argv[2];

	if (command === "doctor") {
		const exitCode = await runDoctor(config, logger);
		process.exit(exitCode);
	}

	if (command === "tunnel") {
		const exitCode = await runTunnel(process.argv.slice(3), logger);
		process.exit(exitCode);
	}

	// Remote (multi-tenant) mode: serve MCP over HTTP instead of stdio, taking
	// each session's VomeHome token from its Authorization header. Deliberately
	// before validateConfig — the process itself needs no token, since every
	// session brings its own.
	if (command === "serve") {
		const exitCode = await runServe(process.argv.slice(3), config, logger);
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

	const ctx = createToolContext(config, logger);
	const { ws } = ctx;

	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	registerAllTools(server, ctx);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	const haMode = describeMode(ctx);
	logger.info(
		`${SERVER_NAME} v${SERVER_VERSION} ready (HA ${haMode}, writes ${config.safety.allowWrite ? "ENABLED" : "disabled"}, esphome ${config.esphome.enabled ? (config.esphome.brokered ? "brokered" : "enabled") : "disabled"}, nodered ${config.nodered.enabled ? "enabled" : "disabled"}, vomehome ${config.vomehome.enabled ? "enabled" : "disabled"})`
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

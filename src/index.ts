#!/usr/bin/env node
import { createRequire } from "node:module";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, validateConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createHaRestClient } from "./ha/restClient.js";
import { createHaWsClient } from "./ha/wsClient.js";
import { createBrokeredWsClient } from "./ha/brokeredClient.js";
import { createEsphomeDashboardClient } from "./esphome/dashboardClient.js";
import { createBrokeredEsphomeDashboardClient } from "./esphome/brokeredDashboardClient.js";
import { createNodeRedClient } from "./nodered/client.js";
import { createVomeHomeClient } from "./vomehome/client.js";
import { createInstanceManager } from "./vomehome/instances.js";
import { registerAllTools } from "./tools/index.js";
import type { ToolContext } from "./tools/helpers.js";
import { runDoctor } from "./cli/doctor.js";
import { runTunnel } from "./cli/tunnel.js";

const SERVER_NAME = "home-assistant-mcp";
// Single source of truth for the version: package.json (works from both
// src/ via tsx and dist/ after build — each is one level below the root).
const SERVER_VERSION = (
	createRequire(import.meta.url)("../package.json") as { version: string }
).version;

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

	// Direct mode gets a single HA client; brokered mode routes per-instance via
	// the manager. Either way `instances.rest` is the stable client the tools use.
	// A small ref breaks the circular init (ws callbacks need the manager before
	// it exists) without a reassigned `let` that prefer-const rejects.
	const instancesRef: {
		current: ReturnType<typeof createInstanceManager> | null;
	} = { current: null };
	const ws = config.brokered
		? createBrokeredWsClient(() => {
				if (!instancesRef.current) {
					throw new Error("VomeHome instance manager is not initialised yet.");
				}
				return instancesRef.current.currentRest();
			})
		: createHaWsClient(config, logger);
	const directRest = config.brokered ? undefined : createHaRestClient(config, logger, ws);
	const instances = createInstanceManager(config, logger, directRest);
	instancesRef.current = instances;
	const rest = instances.rest;
	const esphome = config.esphome.brokered
		? createBrokeredEsphomeDashboardClient(config, logger, () => instances.activeId())
		: createEsphomeDashboardClient(config, logger);
	const nodered = createNodeRedClient(config, logger);
	const vomehome = createVomeHomeClient(config, logger);
	const ctx: ToolContext = { config, logger, rest, ws, esphome, nodered, vomehome, instances };

	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	registerAllTools(server, ctx);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	const haMode = config.brokered
		? `brokered via VomeHome instance ${instances.activeId()} (${config.vomehome.instances.length} declared)`
		: "direct";
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

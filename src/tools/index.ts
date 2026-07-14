import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./helpers.js";
import { registerStateTools } from "./states.js";
import { registerServiceTools } from "./services.js";
import { registerRegistryTools } from "./registry.js";
import { registerTemplateTools } from "./templates.js";
import { registerAutomationTools } from "./automations.js";
import { registerDashboardTools } from "./dashboards.js";
import { registerLogTools } from "./logs.js";
import { registerSystemTools } from "./system.js";
import { registerEsphomeTools } from "./esphome.js";
import { registerNodeRedTools } from "./nodered.js";
import { registerVomeHomeTools } from "./vomehome.js";
import { registerAddonTools } from "./addons.js";
import { registerIntegrationTools } from "./integrations.js";

/** Registers every tool group on the given server. */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
	registerSystemTools(server, ctx);
	registerStateTools(server, ctx);
	registerServiceTools(server, ctx);
	registerRegistryTools(server, ctx);
	registerTemplateTools(server, ctx);
	registerAutomationTools(server, ctx);
	registerDashboardTools(server, ctx);
	registerLogTools(server, ctx);
	registerEsphomeTools(server, ctx);
	registerNodeRedTools(server, ctx);
	registerVomeHomeTools(server, ctx);
	registerAddonTools(server, ctx);
	registerIntegrationTools(server, ctx);
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./helpers.js";
import { withInstanceStamp } from "./instanceStamp.js";
import { registerStateTools } from "./states.js";
import { registerServiceTools } from "./services.js";
import { registerRegistryTools } from "./registry.js";
import { registerTemplateTools } from "./templates.js";
import { registerAutomationTools } from "./automations.js";
import { registerDashboardTools } from "./dashboards.js";
import { registerLogTools } from "./logs.js";
import { registerTraceTools } from "./traces.js";
import { registerSystemTools } from "./system.js";
import { registerEsphomeTools } from "./esphome.js";
import { registerNodeRedTools } from "./nodered.js";
import { registerVomeHomeTools } from "./vomehome.js";
import { registerAddonTools } from "./addons.js";
import { registerIntegrationTools } from "./integrations.js";
import { registerHelperEntityTools } from "./helperEntities.js";
import { registerConfigFileTools } from "./configFiles.js";
import { registerHacsTools } from "./hacs.js";
import { registerUserTools } from "./users.js";

/**
 * Registers every tool group on the given server.
 *
 * The server is wrapped first so that every tool's reply carries the identity
 * of the Home Assistant that answered it — see ``instanceStamp``. Wrapping
 * here rather than at each call site means a tool added later cannot forget
 * to say where it ran.
 */
export function registerAllTools(rawServer: McpServer, ctx: ToolContext): void {
	const server = withInstanceStamp(rawServer, ctx);
	registerSystemTools(server, ctx);
	registerStateTools(server, ctx);
	registerServiceTools(server, ctx);
	registerRegistryTools(server, ctx);
	registerTemplateTools(server, ctx);
	registerAutomationTools(server, ctx);
	registerDashboardTools(server, ctx);
	registerLogTools(server, ctx);
	registerTraceTools(server, ctx);
	registerEsphomeTools(server, ctx);
	registerNodeRedTools(server, ctx);
	registerVomeHomeTools(server, ctx);
	registerAddonTools(server, ctx);
	registerIntegrationTools(server, ctx);
	registerHelperEntityTools(server, ctx);
	registerConfigFileTools(server, ctx);
	registerHacsTools(server, ctx);
	registerUserTools(server, ctx);
}

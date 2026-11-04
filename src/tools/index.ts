import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./helpers.js";
import { withInstanceStamp } from "./instanceStamp.js";
import { withStartingInstanceCheck } from "./instanceCheck.js";
import { registerStateTools } from "./states.js";
import { registerServiceTools } from "./services.js";
import { registerRegistryTools } from "./registry.js";
import { registerTemplateTools } from "./templates.js";
import { registerAutomationTools } from "./automations.js";
import { registerDashboardTools } from "./dashboards.js";
import { registerLogTools } from "./logs.js";
import { registerCameraTools } from "./cameras.js";
import { registerSpeechTools } from "./speech.js";
import { registerTraceTools } from "./traces.js";
import { registerSystemTools } from "./system.js";
import { registerEsphomeTools } from "./esphome.js";
import { registerNodeRedTools } from "./nodered.js";
import { registerVomeHomeTools } from "./vomehome.js";
import { registerVomeHomeChapTools } from "./vomehomeChap.js";
import { registerVomeHomeBackupTools } from "./vomehomeBackups.js";
import { registerAddonTools } from "./addons.js";
import { registerIntegrationTools } from "./integrations.js";
import { registerHelperEntityTools } from "./helperEntities.js";
import { registerConfigFileTools } from "./configFiles.js";
import { registerHacsTools } from "./hacs.js";
import { registerUserTools } from "./users.js";
import { registerServiceLoginTools } from "./serviceLogins.js";
import { registerScriptTools } from "./scripts.js";
import { registerRegistryEditTools } from "./registryEdits.js";
import { registerHealthTools } from "./health.js";
import { registerSnapshotTools } from "./snapshot.js";
import { registerWatchTools } from "./watch.js";
import { registerEnergyTools } from "./energy.js";
import { registerStatisticsTools } from "./statistics.js";
import { registerPeopleTools } from "./people.js";

/**
 * Registers every tool group on the given server.
 *
 * The server is wrapped first so that every tool's reply carries the identity
 * of the Home Assistant that answered it — see ``instanceStamp``. Wrapping
 * here rather than at each call site means a tool added later cannot forget
 * to say where it ran. Inside that, the first call checks the starting
 * instance is online (see ``instanceCheck``); it sits inside so it runs
 * before the stamp's ``instance_id`` guard.
 */
export function registerAllTools(rawServer: McpServer, ctx: ToolContext): void {
	const server = withInstanceStamp(withStartingInstanceCheck(rawServer, ctx), ctx);
	registerSystemTools(server, ctx);
	registerStateTools(server, ctx);
	registerServiceTools(server, ctx);
	registerRegistryTools(server, ctx);
	registerTemplateTools(server, ctx);
	registerAutomationTools(server, ctx);
	registerDashboardTools(server, ctx);
	registerLogTools(server, ctx);
	registerCameraTools(server, ctx);
	registerSpeechTools(server, ctx);
	registerTraceTools(server, ctx);
	registerEsphomeTools(server, ctx);
	registerNodeRedTools(server, ctx);
	registerVomeHomeTools(server, ctx);
	registerVomeHomeChapTools(server, ctx);
	registerVomeHomeBackupTools(server, ctx);
	registerAddonTools(server, ctx);
	registerIntegrationTools(server, ctx);
	registerHelperEntityTools(server, ctx);
	registerConfigFileTools(server, ctx);
	registerHacsTools(server, ctx);
	registerUserTools(server, ctx);
	registerServiceLoginTools(server, ctx);
	registerScriptTools(server, ctx);
	registerRegistryEditTools(server, ctx);
	registerHealthTools(server, ctx);
	registerSnapshotTools(server, ctx);
	registerWatchTools(server, ctx);
	registerEnergyTools(server, ctx);
	registerStatisticsTools(server, ctx);
	registerPeopleTools(server, ctx);
}

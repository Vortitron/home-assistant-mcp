import type { Config } from "../config.js";
import { validateConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { createHaRestClient } from "../ha/restClient.js";
import { createHaWsClient } from "../ha/wsClient.js";
import { createBrokeredHaRestClient } from "../ha/brokeredClient.js";
import { createEsphomeDashboardClient } from "../esphome/dashboardClient.js";
import { createBrokeredEsphomeDashboardClient } from "../esphome/brokeredDashboardClient.js";
import { createNodeRedClient } from "../nodered/client.js";
import { createVomeHomeClient } from "../vomehome/client.js";

function line(text = ""): void {
	process.stdout.write(`${text}\n`);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `home-assistant-mcp doctor` — a human-facing connectivity check that runs the
 * same clients the server uses against the configured Home Assistant. Returns a
 * process exit code (0 = healthy).
 */
export async function runDoctor(config: Config, logger: Logger): Promise<number> {
	line("home-assistant-mcp doctor");
	line("=========================");
	line(`HA mode:           ${config.brokered ? `brokered via VomeHome (instance ${config.vomehome.instanceId})` : "direct"}`);
	line(`HA_URL:            ${config.haUrl || "(not set)"}`);
	line(`HA_TOKEN:          ${config.haToken ? `set (${config.haToken.length} chars)` : "(not set)"}`);
	line(`Writes:            ${config.safety.allowWrite ? "ENABLED" : "disabled"}`);
	line(`Config writes:     ${config.safety.allowConfigWrite ? "ENABLED" : "disabled"}`);
	line(`Deny domains:      ${config.safety.denyDomains.join(", ") || "(none)"}`);
	line(`Allow domains:     ${config.safety.allowDomains.join(", ") || "(any)"}`);
	line(`ESPHome dashboard: ${config.esphome.enabled ? (config.esphome.brokered ? "brokered via VomeHome" : config.esphome.dashboardUrl) : "(not configured)"}`);
	line(`Node-RED:          ${config.nodered.enabled ? config.nodered.url : "(not configured)"}`);
	line(`VomeHome portal:   ${config.vomehome.enabled ? config.vomehome.apiUrl : "(not configured)"}`);
	line("");

	const problems = validateConfig(config);
	if (problems.length > 0) {
		line("Configuration problems:");
		for (const problem of problems) {
			line(`  - ${problem.field}: ${problem.message}`);
		}
		return 1;
	}

	const rest = config.brokered
		? createBrokeredHaRestClient(config, logger)
		: createHaRestClient(config, logger);
	let ok = true;

	try {
		const status = await rest.ping();
		line(`[ok]   REST /api reachable: ${status.message}`);
	} catch (error) {
		ok = false;
		line(`[FAIL] REST /api: ${describe(error)}`);
	}

	try {
		const haConfig = await rest.getConfig();
		const components = Array.isArray(haConfig.components) ? haConfig.components.length : "?";
		line(
			`[ok]   Home Assistant ${haConfig.version ?? "?"} at "${haConfig.location_name ?? "?"}" (${components} components)`
		);
	} catch (error) {
		ok = false;
		line(`[FAIL] /api/config: ${describe(error)}`);
	}

	try {
		const states = await rest.getStates();
		line(`[ok]   ${states.length} entities visible`);
	} catch (error) {
		ok = false;
		line(`[FAIL] /api/states: ${describe(error)}`);
	}

	if (config.brokered) {
		line("[info] WebSocket registry: skipped (not exposed in brokered mode; use ha_list_entities)");
	} else {
		const ws = createHaWsClient(config, logger);
		try {
			const areas = await ws.listAreas();
			line(`[ok]   WebSocket registry reachable: ${areas.length} areas`);
		} catch (error) {
			ok = false;
			line(`[FAIL] WebSocket registry: ${describe(error)}`);
		} finally {
			await ws.close().catch(() => undefined);
		}
	}

	if (config.esphome.enabled) {
		const esphome = config.esphome.brokered
			? createBrokeredEsphomeDashboardClient(config, logger)
			: createEsphomeDashboardClient(config, logger);
		try {
			await esphome.listDevices();
			line(`[ok]   ESPHome dashboard reachable${config.esphome.brokered ? " (brokered)" : ""}`);
		} catch (error) {
			line(`[warn] ESPHome dashboard: ${describe(error)}`);
		}
	}

	if (config.nodered.enabled) {
		const nodered = createNodeRedClient(config, logger);
		try {
			const settings = (await nodered.getSettings()) as { version?: unknown } | undefined;
			const version = settings && typeof settings.version === "string" ? settings.version : "?";
			line(`[ok]   Node-RED reachable (version ${version})`);
		} catch (error) {
			line(`[warn] Node-RED: ${describe(error)}`);
		}
	}

	if (config.vomehome.enabled) {
		const vomehome = createVomeHomeClient(config, logger);
		try {
			const instances = await vomehome.listInstances();
			line(`[ok]   VomeHome portal reachable: ${instances.length} instance(s)`);
		} catch (error) {
			line(`[warn] VomeHome portal: ${describe(error)}`);
		}
	}

	line("");
	line(ok ? "All core checks passed." : "Some checks failed (see above).");
	return ok ? 0 : 1;
}

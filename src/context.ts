/**
 * Builds a {@link ToolContext} — everything the 59 registered tools need.
 *
 * Split out of index.ts so the stdio server (one context for the process, from
 * the environment) and the HTTP server (one context per MCP session, from that
 * session's bearer token) construct their clients identically. Nothing here
 * touches `process.env` or module-level state, so contexts are fully isolated
 * from one another — which is what makes the multi-tenant HTTP mode safe.
 */
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { createHaRestClient } from "./ha/restClient.js";
import { createHaWsClient } from "./ha/wsClient.js";
import { createBrokeredWsClient } from "./ha/brokeredClient.js";
import { createBrokeredEsphomeDashboardClient } from "./esphome/brokeredDashboardClient.js";
import { createUnavailableEsphomeClient } from "./esphome/client.js";
import { createNodeRedClient } from "./nodered/client.js";
import { createVomeHomeClient } from "./vomehome/client.js";
import { createInstanceManager } from "./vomehome/instances.js";
import type { ToolContext } from "./tools/helpers.js";

export function createToolContext(config: Config, logger: Logger): ToolContext {
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
	// One route to ESPHome: the VomeHome relay, where the Vome component
	// translates the dashboard's /ws API. Without one, a client that refuses
	// every call with the same explanation, rather than tools that fail
	// differently depending on which one is called first.
	const esphome = config.esphome.brokered
		? createBrokeredEsphomeDashboardClient(config, logger, () => instances.activeId())
		: createUnavailableEsphomeClient();
	const nodered = createNodeRedClient(config, logger);
	const vomehome = createVomeHomeClient(config, logger);
	return {
		config,
		logger,
		rest: instances.rest,
		ws,
		esphome,
		nodered,
		vomehome,
		instances
	};
}

/** One-line summary of how a context reaches Home Assistant, for startup logs. */
export function describeMode(ctx: ToolContext): string {
	const { config, instances } = ctx;
	return config.brokered
		? `brokered via VomeHome instance ${instances.activeId()} (${config.vomehome.instances.length} declared)`
		: "direct";
}

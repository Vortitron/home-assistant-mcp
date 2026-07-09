import type { Config, InstanceAccess, SafetyConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { HaApiError } from "../ha/restClient.js";
import type { HaRequestOptions, HaRestClient } from "../ha/restClient.js";
import { createBrokeredHaRestClient } from "../ha/brokeredClient.js";

/**
 * Multi-instance access manager.
 *
 * The MCP can talk to more than one VomeHome instance. This manager owns:
 *   - a per-instance access registry (each instance's own write/config flags —
 *     distinct from the account-wide VOMEHOME_ALLOW_CREATE);
 *   - the currently-active instance (HA tools route here);
 *   - a cache of brokered REST clients, one per instance;
 *   - a stable {@link HaRestClient} proxy (`rest`) that always forwards to the
 *     active instance so tools never hold a stale, single-instance client.
 *
 * It is created once in index.ts and threaded through the ToolContext — there is
 * no module-level mutable singleton. The only mutable state (active instance +
 * runtime-created instances) lives on this per-process object.
 */

const DIRECT_ID = "(direct)";

export interface ResolvedTarget {
	id: string;
	access: InstanceAccess;
	/** True when the instance was declared (env or created), not a transient read-only target. */
	inRegistry: boolean;
}

export interface InstanceManager {
	/** True in brokered mode (multi-instance applies); false for a single direct HA. */
	readonly brokered: boolean;
	/** Stable client that always targets the active instance. Tools use this. */
	readonly rest: HaRestClient;
	/** The active instance id (what HA tools currently target). */
	activeId(): string;
	/** The full access registry (copied), for tool output / diagnostics. */
	list(): InstanceAccess[];
	/** True when an instance id is declared in the registry. */
	has(id: string): boolean;
	/** Resolved access for an instance (active when omitted). */
	access(instanceId?: string): InstanceAccess;
	/** Safety policy for an instance: per-instance write/config + global deny/allow domains. */
	safetyFor(instanceId?: string): SafetyConfig;
	/** Safety policy for the active instance. */
	currentSafety(): SafetyConfig;
	/** Brokered REST client for the active instance (or the single direct client). */
	currentRest(): HaRestClient;
	/** Switch the active instance. Undeclared ids become transient read-only targets. */
	use(instanceId: string): ResolvedTarget;
	/**
	 * Register an instance created via the MCP with full (write + config) access
	 * and make it active. Implements "if you can create it, you own it".
	 */
	registerCreated(id: string, label?: string): InstanceAccess;
}

export function createInstanceManager(
	config: Config,
	logger: Logger,
	directRest?: HaRestClient
): InstanceManager {
	const brokered = config.brokered;
	const registry = new Map<string, InstanceAccess>();
	for (const entry of config.vomehome.instances) {
		registry.set(entry.id, { ...entry });
	}
	// Direct mode: a single implicit instance whose access is the global safety.
	if (!brokered) {
		registry.set(DIRECT_ID, {
			id: DIRECT_ID,
			write: config.safety.allowWrite,
			config: config.safety.allowConfigWrite,
			label: "direct"
		});
	}

	let active = brokered
		? config.vomehome.instanceId || config.vomehome.instances[0]?.id || ""
		: DIRECT_ID;

	const clientCache = new Map<string, HaRestClient>();

	function readOnlyEntry(id: string): InstanceAccess {
		return { id, write: false, config: false };
	}

	function access(instanceId?: string): InstanceAccess {
		const id = instanceId ?? active;
		if (!brokered) {
			return registry.get(DIRECT_ID) as InstanceAccess;
		}
		return registry.get(id) ?? readOnlyEntry(id);
	}

	function safetyFor(instanceId?: string): SafetyConfig {
		const a = access(instanceId);
		return {
			allowWrite: a.write,
			allowConfigWrite: a.config,
			denyDomains: config.safety.denyDomains,
			allowDomains: config.safety.allowDomains
		};
	}

	function restFor(id: string): HaRestClient {
		if (!brokered) {
			if (!directRest) {
				throw new HaApiError("No Home Assistant REST client is configured.", 0, "");
			}
			return directRest;
		}
		if (!id) {
			throw new HaApiError(
				"No active VomeHome instance is selected. Set VOMEHOME_INSTANCE_ID, declare VOMEHOME_INSTANCES, " +
					"or call vomehome_use_instance / vomehome_create_instance first.",
				0,
				""
			);
		}
		let client = clientCache.get(id);
		if (!client) {
			client = createBrokeredHaRestClient(config, logger, id);
			clientCache.set(id, client);
		}
		return client;
	}

	function currentRest(): HaRestClient {
		return restFor(active);
	}

	function use(instanceId: string): ResolvedTarget {
		const id = (instanceId ?? "").trim();
		if (!id) {
			throw new HaApiError("instance_id is required.", 0, "");
		}
		if (!brokered) {
			return { id: DIRECT_ID, access: registry.get(DIRECT_ID) as InstanceAccess, inRegistry: true };
		}
		const inRegistry = registry.has(id);
		if (!inRegistry) {
			// Allow read-only access to an undeclared (but token-reachable) instance.
			registry.set(id, readOnlyEntry(id));
		}
		active = id;
		logger.debug(`Active VomeHome instance -> ${id}`);
		return { id, access: registry.get(id) as InstanceAccess, inRegistry };
	}

	function registerCreated(id: string, label?: string): InstanceAccess {
		const entry: InstanceAccess = { id, write: true, config: true, created: true };
		if (label) {
			entry.label = label;
		}
		registry.set(id, entry);
		if (brokered) {
			active = id;
			clientCache.delete(id);
		}
		logger.debug(`Registered created instance ${id} with full access (now active)`);
		return entry;
	}

	// A stable proxy implementing HaRestClient by delegating every call to the
	// active instance's client. Tools keep `ctx.rest` and never see the switch.
	const rest: HaRestClient = {
		request<T = unknown>(path: string, options?: HaRequestOptions): Promise<T> {
			return currentRest().request<T>(path, options);
		},
		ping: () => currentRest().ping(),
		getConfig: () => currentRest().getConfig(),
		getStates: () => currentRest().getStates(),
		getState: (entityId) => currentRest().getState(entityId),
		getServices: () => currentRest().getServices(),
		callService: (domain, service, data, target) =>
			currentRest().callService(domain, service, data, target),
		renderTemplate: (template, variables) => currentRest().renderTemplate(template, variables),
		checkConfig: () => currentRest().checkConfig(),
		getErrorLog: () => currentRest().getErrorLog(),
		getLogbook: (params) => currentRest().getLogbook(params),
		getHistory: (params) => currentRest().getHistory(params),
		fireEvent: (eventType, data) => currentRest().fireEvent(eventType, data),
		getAutomationConfig: (automationId) => currentRest().getAutomationConfig(automationId),
		upsertAutomationConfig: (automationId, automationConfig) =>
			currentRest().upsertAutomationConfig(automationId, automationConfig),
		deleteAutomationConfig: (automationId) => currentRest().deleteAutomationConfig(automationId),
		sendWsCommand: (command) => currentRest().sendWsCommand(command)
	};

	return {
		brokered,
		rest,
		activeId: () => active,
		list: () => [...registry.values()].map((entry) => ({ ...entry })),
		has: (id) => registry.has(id),
		access,
		safetyFor,
		currentSafety: () => safetyFor(active),
		currentRest,
		use,
		registerCreated
	};
}

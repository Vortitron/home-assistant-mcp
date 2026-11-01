import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SafetyConfig } from "../config.js";
import type { HaServiceDomain, HaTarget } from "../ha/types.js";
import { SERVICE_MAX_TIMEOUT_SECONDS, splitServiceResult } from "../ha/restClient.js";
import { evaluateDomainWrite, extractDomain } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Service domains whose services fan out across *every* domain in a target
 * (e.g. `homeassistant.turn_on`/`turn_off`/`toggle`/`update_entity`). For these
 * the affected domain is NOT the service domain, so an area/device/label target
 * could silently reach a denied domain (lock, alarm, …). Domain-specific
 * services (e.g. `light.turn_on`) only ever act on their own domain's entities,
 * so the service-domain check already covers them.
 */
const GENERIC_SERVICE_DOMAINS = new Set(["homeassistant"]);

function pushIds(value: unknown, ids: string[]): void {
	if (typeof value === "string") {
		ids.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === "string") {
				ids.push(item);
			}
		}
	}
}

/**
 * Collect every `entity_id` reachable in the call — top-level and nested inside
 * `data` (some services accept entity ids under nested keys) plus the target —
 * so the deny-list can't be bypassed by burying the id (e.g.
 * `data.options.entity_id`).
 */
function collectEntityIds(
	data: Record<string, unknown> | undefined,
	target: HaTarget | undefined
): string[] {
	const ids: string[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) {
				walk(item);
			}
		} else if (node !== null && typeof node === "object") {
			for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
				if (key === "entity_id") {
					pushIds(value, ids);
				} else {
					walk(value);
				}
			}
		}
	};
	walk(data);
	pushIds(target?.entity_id, ids);
	return ids;
}

/** True when the target selects entities by area/device/label (not by id). */
function targetsUnresolvableSelectors(target: HaTarget | undefined): boolean {
	return Boolean(
		target &&
			(target.area_id !== undefined ||
				target.device_id !== undefined ||
				target.label_id !== undefined)
	);
}

/** True when the safety policy could deny some domain (deny-list or allow-list). */
function hasDomainRestrictions(safety: SafetyConfig): boolean {
	return safety.denyDomains.length > 0 || safety.allowDomains.length > 0;
}

/** `domain.service` for every service that can return a response. */
export function servicesWithResponses(domains: HaServiceDomain[]): Set<string> {
	const out = new Set<string>();
	for (const entry of domains ?? []) {
		for (const [name, service] of Object.entries(entry?.services ?? {})) {
			const response = (service as { response?: unknown })?.response;
			if (response && typeof response === "object") {
				out.add(`${entry.domain}.${name}`);
			}
		}
	}
	return out;
}

/**
 * How long a home's list of response-capable services is trusted. The full
 * service list is large (hundreds of KB over the relay), so it is not fetched
 * per call; a new integration's services are picked up within this window,
 * and a service that needs a response regardless is retried with it anyway.
 */
const RESPONSE_SUPPORT_TTL_MS = 10 * 60 * 1000;

/**
 * Per-instance memory of which services can return a response, so
 * ha_call_service can ask for it (?return_response) only where Home
 * Assistant accepts it.
 */
function createResponseSupport(ctx: ToolContext) {
	const byInstance = new Map<string, { at: number; services: Set<string> }>();

	/** Records a freshly fetched service list (ha_list_services fetches it anyway). */
	function remember(domains: HaServiceDomain[]): void {
		byInstance.set(ctx.instances.activeId(), { at: Date.now(), services: servicesWithResponses(domains) });
	}

	/** True / false, or undefined when the list could not be read. */
	async function supports(domain: string, service: string): Promise<boolean | undefined> {
		const id = ctx.instances.activeId();
		let hit = byInstance.get(id);
		if (!hit || Date.now() - hit.at > RESPONSE_SUPPORT_TTL_MS) {
			try {
				remember(await ctx.rest.getServices());
			} catch (error) {
				ctx.logger.debug(`Could not read services to check response support: ${String(error)}`);
				return undefined;
			}
			hit = byInstance.get(id);
		}
		return hit?.services.has(`${domain}.${service}`);
	}

	return { remember, supports };
}

export function registerServiceTools(server: McpServer, ctx: ToolContext): void {
	const responseSupport = createResponseSupport(ctx);

	server.registerTool(
		"ha_list_services",
		{
			title: "List services",
			description:
				"List callable Home Assistant services. Without a domain, returns every domain and its service names. With a domain, returns that domain's services including their fields/parameters so you know what data to pass to ha_call_service.",
			inputSchema: {
				domain: z.string().optional().describe("Restrict to one domain, e.g. 'light'.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ domain }) =>
			runTool(ctx.logger, "ha_list_services", async () => {
				const domains = await ctx.rest.getServices();
				responseSupport.remember(domains);
				if (domain) {
					const match = domains.find((entry) => entry.domain === domain);
					if (!match) {
						return jsonResult({ domain, found: false, services: {} });
					}
					return jsonResult({ domain, found: true, services: match.services });
				}
				const summary = domains.map((entry) => ({
					domain: entry.domain,
					services: Object.keys(entry.services)
				}));
				return jsonResult({ count: summary.length, domains: summary });
			})
	);

	server.registerTool(
		"ha_call_service",
		{
			title: "Call a service",
			description:
				"Call a Home Assistant service to change state (e.g. domain='light', service='turn_on', data={ brightness_pct: 60 }, target={ entity_id: 'light.kitchen' }). Refused unless writes are enabled, and blocked for denied domains. Returns the entities that changed, and service_response for services that return data: a service that can return a response (shell_command's stdout, stderr and returncode; script; weather.get_forecasts; calendar.get_events …) is asked for it automatically.",
			inputSchema: {
				domain: z.string().describe("Service domain, e.g. 'light', 'switch', 'climate'."),
				service: z.string().describe("Service name, e.g. 'turn_on', 'set_temperature'."),
				data: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Service data / parameters (may include entity_id)."),
				target: z
					.object({
						entity_id: z.union([z.string(), z.array(z.string())]).optional(),
						area_id: z.union([z.string(), z.array(z.string())]).optional(),
						device_id: z.union([z.string(), z.array(z.string())]).optional(),
						label_id: z.union([z.string(), z.array(z.string())]).optional()
					})
					.optional()
					.describe("Service target (entity/area/device/label selectors)."),
				timeout_seconds: z
					.number()
					.int()
					.positive()
					.max(SERVICE_MAX_TIMEOUT_SECONDS)
					.optional()
					.describe(
						"How long to wait for the service to answer (default 15 s, at most 50). For slow actions: " +
							"ai_task.generate_data with an image attached, a script that waits, a cloud call."
					),
				return_response: z
					.boolean()
					.optional()
					.describe(
						"Ask for the service's response. Default: automatically when Home Assistant lists the service " +
							"as able to return one. false never asks (a service that requires it is still asked)."
					)
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ domain, service, data, target, timeout_seconds, return_response }) =>
			runTool(ctx.logger, "ha_call_service", async () => {
				// Per-instance write policy (deny/allow domains stay global).
				const safety = ctx.instances.currentSafety();
				const serviceDecision = evaluateDomainWrite(domain, safety);
				if (!serviceDecision.allowed) {
					return errorResult(`Refused: ${serviceDecision.reason}`);
				}
				// Guard against bypassing the deny-list via cross-domain services
				// (e.g. homeassistant.turn_on targeting a lock) — check every
				// entity_id, including ones nested inside `data`.
				for (const entityId of collectEntityIds(data, target)) {
					const targetDecision = evaluateDomainWrite(extractDomain(entityId), safety);
					if (!targetDecision.allowed) {
						return errorResult(`Refused for target '${entityId}': ${targetDecision.reason}`);
					}
				}
				// Area/device/label selectors resolve to entities server-side, so we
				// can't tell here whether they include a denied domain. For a generic
				// service (which acts on any domain) with an active deny/allow-list,
				// that's an un-checkable bypass — refuse and ask for entity_id targeting.
				if (
					GENERIC_SERVICE_DOMAINS.has(extractDomain(domain)) &&
					targetsUnresolvableSelectors(target) &&
					hasDomainRestrictions(safety)
				) {
					return errorResult(
						`Refused: '${domain}.${service}' targets an area/device/label, which can't be checked ` +
							`against the domain deny/allow-list from here (it could include a protected domain such as a lock). ` +
							`Target specific entity_id(s) instead, or call the domain-specific service (e.g. 'light.${service}').`
					);
				}
				const returnResponse = return_response ?? (await responseSupport.supports(domain, service)) === true;
				const { changed, response } = splitServiceResult(
					await ctx.rest.callService(domain, service, data ?? {}, target, {
						timeoutSeconds: timeout_seconds,
						returnResponse
					})
				);
				return jsonResult({
					called: `${domain}.${service}`,
					changed_entities: changed.map((state) => ({
						entity_id: state.entity_id,
						state: state.state
					})),
					raw_changed_count: changed.length,
					// What a service that returns data said (vomesync.subscribe_switch, ...).
					...(response === undefined ? {} : { service_response: response }),
					...(returnResponse && response === undefined
						? {
								service_response_note:
									"The response was asked for but none came back. Through Vome this needs a portal " +
									"that passes return_response on to the home; on a direct connection the service " +
									"returned nothing."
							}
						: {})
				});
			})
	);
}

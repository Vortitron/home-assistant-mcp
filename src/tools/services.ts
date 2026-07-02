import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SafetyConfig } from "../config.js";
import type { HaTarget } from "../ha/types.js";
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

export function registerServiceTools(server: McpServer, ctx: ToolContext): void {
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
				"Call a Home Assistant service to change state (e.g. domain='light', service='turn_on', data={ brightness_pct: 60 }, target={ entity_id: 'light.kitchen' }). Refused unless writes are enabled, and blocked for denied domains. Returns the entities that changed.",
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
					.describe("Service target (entity/area/device/label selectors).")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ domain, service, data, target }) =>
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
				const changed = await ctx.rest.callService(domain, service, data ?? {}, target);
				return jsonResult({
					called: `${domain}.${service}`,
					changed_entities: changed.map((state) => ({
						entity_id: state.entity_id,
						state: state.state
					})),
					raw_changed_count: changed.length
				});
			})
	);
}

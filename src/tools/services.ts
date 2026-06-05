import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HaTarget } from "../ha/types.js";
import { evaluateDomainWrite, extractDomain } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

function collectEntityIds(
	data: Record<string, unknown> | undefined,
	target: HaTarget | undefined
): string[] {
	const ids: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === "string") {
			ids.push(value);
		} else if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") {
					ids.push(item);
				}
			}
		}
	};
	push(data?.entity_id);
	push(target?.entity_id);
	return ids;
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
				const serviceDecision = evaluateDomainWrite(domain, ctx.config.safety);
				if (!serviceDecision.allowed) {
					return errorResult(`Refused: ${serviceDecision.reason}`);
				}
				// Guard against bypassing the deny-list via cross-domain services
				// (e.g. homeassistant.turn_on targeting a lock).
				for (const entityId of collectEntityIds(data, target)) {
					const targetDecision = evaluateDomainWrite(extractDomain(entityId), ctx.config.safety);
					if (!targetDecision.allowed) {
						return errorResult(`Refused for target '${entityId}': ${targetDecision.reason}`);
					}
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

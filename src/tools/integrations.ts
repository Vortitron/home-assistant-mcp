import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

const VOME_DOMAIN = "vomesync";

interface ConfigFlowStep {
	type?: string;
	flow_id?: string;
	handler?: string;
	step_id?: string;
	errors?: Record<string, string>;
	description_placeholders?: Record<string, string>;
	[key: string]: unknown;
}

/** Call HA config-entry REST paths (direct) or the matching VomeHome broker routes. */
async function configEntriesGet<T>(ctx: ToolContext, haApiPath: string): Promise<T> {
	if (!ctx.config.brokered) {
		return ctx.rest.request<T>(`/api${haApiPath}`);
	}
	const instanceId = ctx.instances.activeId();
	const url =
		`${ctx.config.vomehome.apiUrl}/api/v1/instances/${encodeURIComponent(instanceId)}/ha${haApiPath}`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${ctx.config.vomehome.token}`,
			"Content-Type": "application/json"
		}
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`GET ${haApiPath} failed (${response.status}): ${text.slice(0, 400)}`);
	}
	return (text ? JSON.parse(text) : undefined) as T;
}

async function configEntriesPost<T>(
	ctx: ToolContext,
	haApiPath: string,
	body: Record<string, unknown>
): Promise<T> {
	if (!ctx.config.brokered) {
		return ctx.rest.request<T>(`/api${haApiPath}`, { method: "POST", body });
	}
	const instanceId = ctx.instances.activeId();
	const url =
		`${ctx.config.vomehome.apiUrl}/api/v1/instances/${encodeURIComponent(instanceId)}/ha${haApiPath}`;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${ctx.config.vomehome.token}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify(body)
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`POST ${haApiPath} failed (${response.status}): ${text.slice(0, 400)}`);
	}
	return (text ? JSON.parse(text) : undefined) as T;
}

function isCreateEntry(step: ConfigFlowStep): boolean {
	return step.type === "create_entry";
}

interface DiscoveryFlow {
	flow_id?: string;
	handler?: string;
	step_id?: string;
	context?: {
		source?: string;
		unique_id?: string;
		title_placeholders?: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/**
 * Pull the identifying details out of a discovery flow's context.
 *
 * Integrations put these in wildly different shapes (dhcp uses `ip`/`macaddress`,
 * zeroconf nests under `properties`, tuya_local carries the Tuya device id), so
 * this looks for the handful of keys that actually identify a device rather than
 * assuming any one layout. Everything is still returned in `raw_context`.
 */
function summariseDiscovery(flow: DiscoveryFlow): Record<string, unknown> {
	const context = flow.context ?? {};
	const nested =
		(context.properties as Record<string, unknown> | undefined) ??
		(context.discovery_info as Record<string, unknown> | undefined) ??
		{};
	const interesting = [
		"host",
		"ip",
		"ip_address",
		"address",
		"hostname",
		"macaddress",
		"mac",
		"port",
		"device_id",
		"gwId",
		"serial",
		"serial_number",
		"model",
		"name",
		"product_key",
		"productKey"
	];

	const summary: Record<string, unknown> = {};
	for (const key of interesting) {
		const value = context[key] ?? nested[key];
		if (value !== undefined && value !== null && value !== "") {
			summary[key] = value;
		}
	}
	// title_placeholders is where most integrations put the human-facing label,
	// and for several (tuya_local included) it is the only place the address appears.
	for (const [key, value] of Object.entries(context.title_placeholders ?? {})) {
		if (value !== undefined && value !== null && value !== "" && !(key in summary)) {
			summary[key] = value;
		}
	}
	return summary;
}

export function registerIntegrationTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_config_entries",
		{
			title: "List config entries (integrations)",
			description:
				"List installed Home Assistant config entries (integrations). Optional domain filter, e.g. vomesync.",
			inputSchema: {
				domain: z
					.string()
					.optional()
					.describe("Optional integration domain filter (e.g. vomesync, mqtt)")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ domain }) =>
			runTool(ctx.logger, "ha_list_config_entries", async () => {
				const qs = domain ? `?domain=${encodeURIComponent(domain)}` : "";
				const entries = await configEntriesGet<unknown[]>(
					ctx,
					`/config/config_entries/entry${qs}`
				);
				const rows = Array.isArray(entries) ? entries : [];
				return jsonResult({ count: rows.length, entries: rows });
			})
	);

	server.registerTool(
		"ha_list_discovery_flows",
		{
			title: "List in-progress (discovered) config flows",
			description:
				"List config flows Home Assistant has started but not finished — chiefly integrations " +
				"discovered on the network and waiting to be added. Each row carries the discovery " +
				"context (host/IP, device id, model, serial) the integration matched on, so this " +
				"answers 'what has HA found that is not set up yet?'. Optional domain filter.",
			inputSchema: {
				domain: z
					.string()
					.optional()
					.describe("Optional integration domain filter (e.g. tuya_local, esphome)"),
				include_user_flows: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Include flows the user started by hand; by default only discovered flows are returned"
					)
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ domain, include_user_flows }) =>
			runTool(ctx.logger, "ha_list_discovery_flows", async () => {
				// HA only returns discovery-sourced flows for ?type=integration; user-started
				// flows are transient and are fetched unfiltered.
				const flows = await configEntriesGet<DiscoveryFlow[]>(
					ctx,
					include_user_flows
						? "/config/config_entries/flow"
						: "/config/config_entries/flow?type=integration"
				);
				let rows = Array.isArray(flows) ? flows : [];
				if (domain) {
					rows = rows.filter((flow) => flow.handler === domain);
				}
				return jsonResult({
					count: rows.length,
					flows: rows.map((flow) => ({
						flow_id: flow.flow_id,
						handler: flow.handler,
						step_id: flow.step_id,
						source: flow.context?.source,
						title: flow.context?.title_placeholders,
						unique_id: flow.context?.unique_id,
						discovery: summariseDiscovery(flow),
						raw_context: flow.context
					})),
					hint:
						rows.length > 0
							? "Continue one with ha_config_flow using its flow_id."
							: "Nothing pending. Discovery only surfaces devices on the HA host's own network."
				});
			})
	);

	server.registerTool(
		"ha_config_flow",
		{
			title: "Start or continue a config flow",
			description:
				"Add or configure an integration via Home Assistant's config flow API. " +
				"Start: pass handler (domain). Continue: pass flow_id + user_input for the current step. " +
				"Requires ha:config (brokered) or HA_ALLOW_CONFIG_WRITE (direct).",
			inputSchema: {
				handler: z
					.string()
					.optional()
					.describe("Integration domain to start a new flow for (e.g. vomesync)"),
				flow_id: z
					.string()
					.optional()
					.describe("Existing flow id to continue"),
				user_input: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Step answers when continuing (or defaults when starting)"),
				show_advanced_options: z.boolean().optional().default(false)
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ handler, flow_id, user_input, show_advanced_options }) =>
			runTool(ctx.logger, "ha_config_flow", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(decision.reason);
				}
				if (flow_id) {
					const step = await configEntriesPost<ConfigFlowStep>(
						ctx,
						`/config/config_entries/flow/${encodeURIComponent(flow_id)}`,
						user_input ?? {}
					);
					return jsonResult({ step });
				}
				if (!handler) {
					return errorResult("Provide handler to start a flow, or flow_id to continue one.");
				}
				const started = await configEntriesPost<ConfigFlowStep>(
					ctx,
					"/config/config_entries/flow",
					{
						handler,
						show_advanced_options: Boolean(show_advanced_options)
					}
				);
				if (user_input && started.type === "form" && started.flow_id) {
					const step = await configEntriesPost<ConfigFlowStep>(
						ctx,
						`/config/config_entries/flow/${encodeURIComponent(started.flow_id)}`,
						user_input
					);
					return jsonResult({ started, step });
				}
				return jsonResult({ step: started });
			})
	);

	server.registerTool(
		"ha_integration_setup_vome",
		{
			title: "Add the Vome (vomesync) integration",
			description:
				"Ensure the Vome custom component is set up as a config entry: start the vomesync " +
				"config flow and submit defaults (new signing key + default sync.vome.io URLs). " +
				"Idempotent if an entry already exists. Requires Core restart after the add-on " +
				"first installed custom_components/vomesync. Needs ha:config.",
			inputSchema: {
				uid: z
					.string()
					.optional()
					.describe("Optional switch UID (or uid/access_key) to subscribe on first setup"),
				force: z
					.boolean()
					.optional()
					.default(false)
					.describe("If true, start another flow even when a vomesync entry already exists")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ uid, force }) =>
			runTool(ctx.logger, "ha_integration_setup_vome", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(decision.reason);
				}

				const existing = await configEntriesGet<
					Array<{ domain?: string; title?: string; entry_id?: string }>
				>(ctx, `/config/config_entries/entry?domain=${encodeURIComponent(VOME_DOMAIN)}`);
				const rows = Array.isArray(existing) ? existing : [];
				if (rows.length > 0 && !force) {
					return jsonResult({
						ok: true,
						already_configured: true,
						entries: rows,
						hint: "Vome integration already present. Pass force=true to add another entry."
					});
				}

				const started = await configEntriesPost<ConfigFlowStep>(
					ctx,
					"/config/config_entries/flow",
					{
						handler: VOME_DOMAIN,
						show_advanced_options: false
					}
				);
				if (started.type === "abort") {
					return jsonResult({
						ok: false,
						step: started,
						error:
							"Config flow aborted — is custom_components/vomesync installed and Core restarted?"
					});
				}
				if (!started.flow_id) {
					return errorResult(`Unexpected flow response: ${JSON.stringify(started)}`);
				}

				const userInput: Record<string, unknown> = {
					generate_new_key: true,
					use_default_urls: true
				};
				if (uid && uid.trim()) {
					userInput.uid = uid.trim();
				}

				const step = await configEntriesPost<ConfigFlowStep>(
					ctx,
					`/config/config_entries/flow/${encodeURIComponent(started.flow_id)}`,
					userInput
				);

				if (isCreateEntry(step)) {
					return jsonResult({
						ok: true,
						created: true,
						step,
						next_steps: [
							"Open the Vome sidebar (add-on ingress) or integration options for remote access / LAN tunnels.",
							"Keep the generated signing key safe if you need to migrate this entry later (shown once in the UI)."
						]
					});
				}

				return jsonResult({
					ok: false,
					started,
					step,
					hint:
						step.type === "form"
							? "Flow needs more input — call ha_config_flow with this flow_id and user_input."
							: "Flow did not create an entry. Check errors / abort reason."
				});
			})
	);
}

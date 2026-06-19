import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Node-RED admin API tools. Reads are always available once NODERED_URL is set;
 * writes (deploying flows) are gated behind the same config-write guard as
 * editing Home Assistant automations — HA_ALLOW_WRITE=true *and*
 * HA_ALLOW_CONFIG_WRITE=true — because a flow deploy rewrites automation logic.
 */
export function registerNodeRedTools(server: McpServer, ctx: ToolContext): void {
	const guardConfigWrite = (): string | undefined => {
		const decision = evaluateConfigWrite(ctx.config.safety);
		return decision.allowed ? undefined : `Refused: ${decision.reason}`;
	};

	server.registerTool(
		"nodered_get_flows",
		{
			title: "Get Node-RED flows",
			description:
				"Get the full Node-RED flow configuration (the JSON array of all nodes across every tab) plus the current revision string. Pass that 'rev' back to nodered_set_flows to avoid clobbering a concurrent change. Prefer nodered_get_flow / nodered_update_flow for single-tab edits.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "nodered_get_flows", async () => {
				const result = await ctx.nodered.getFlows();
				return jsonResult({ rev: result.rev, flows: result.flows });
			})
	);

	server.registerTool(
		"nodered_get_flow",
		{
			title: "Get one Node-RED flow (tab)",
			description:
				"Get a single Node-RED flow (one editor tab) and its nodes by flow id. Use nodered_get_flows first to discover tab ids and labels.",
			inputSchema: {
				id: z.string().describe("Flow (tab) id, e.g. the 'id' of a tab node from nodered_get_flows.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ id }) =>
			runTool(ctx.logger, "nodered_get_flow", async () => {
				const flow = await ctx.nodered.getFlow(id);
				return jsonResult(flow);
			})
	);

	server.registerTool(
		"nodered_list_nodes",
		{
			title: "List installed Node-RED nodes",
			description:
				"List the installed Node-RED node modules and the node types they provide (the palette). Use this to check which node types are available before writing a flow that references them.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "nodered_list_nodes", async () => {
				const nodes = await ctx.nodered.listNodes();
				return jsonResult(nodes);
			})
	);

	server.registerTool(
		"nodered_create_flow",
		{
			title: "Create a Node-RED flow (tab)",
			description:
				"Add a new Node-RED flow (a new tab) with its nodes, leaving existing flows untouched. The 'flow' object should have a 'label' and a 'nodes' array (Node-RED node objects). Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true. Safer than nodered_set_flows because it cannot disturb other tabs.",
			inputSchema: {
				flow: z
					.record(z.unknown())
					.describe("Flow object: { label, nodes: [...], configs?: [...] }. The new tab id is returned.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ flow }) =>
			runTool(ctx.logger, "nodered_create_flow", async () => {
				const refusal = guardConfigWrite();
				if (refusal) {
					return errorResult(refusal);
				}
				const created = await ctx.nodered.createFlow(flow);
				return jsonResult({ created: true, flow: created });
			})
	);

	server.registerTool(
		"nodered_update_flow",
		{
			title: "Update a Node-RED flow (tab)",
			description:
				"Replace a single Node-RED flow (one tab) and its nodes by id, leaving other tabs untouched. Read it first with nodered_get_flow, edit, then send the whole flow object back. Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true.",
			inputSchema: {
				id: z.string().describe("Flow (tab) id to update."),
				flow: z
					.record(z.unknown())
					.describe("Full flow object for this tab: { id, label, nodes: [...], configs?: [...] }.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true }
		},
		async ({ id, flow }) =>
			runTool(ctx.logger, "nodered_update_flow", async () => {
				const refusal = guardConfigWrite();
				if (refusal) {
					return errorResult(refusal);
				}
				const updated = await ctx.nodered.updateFlow(id, flow);
				return jsonResult({ updated: true, id, flow: updated });
			})
	);

	server.registerTool(
		"nodered_delete_flow",
		{
			title: "Delete a Node-RED flow (tab)",
			description:
				"Delete an entire Node-RED flow (one tab) and all of its nodes by id. This cannot be undone from here. Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true.",
			inputSchema: {
				id: z.string().describe("Flow (tab) id to delete.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ id }) =>
			runTool(ctx.logger, "nodered_delete_flow", async () => {
				const refusal = guardConfigWrite();
				if (refusal) {
					return errorResult(refusal);
				}
				await ctx.nodered.deleteFlow(id);
				return jsonResult({ deleted: true, id });
			})
	);

	server.registerTool(
		"nodered_set_flows",
		{
			title: "Replace ALL Node-RED flows",
			description:
				"Replace the ENTIRE Node-RED flow configuration and deploy. This overwrites every tab — prefer nodered_create_flow / nodered_update_flow unless you really mean to rewrite everything. Pass the 'rev' from nodered_get_flows to avoid clobbering a concurrent change. deployment_type controls how Node-RED applies it ('full' restarts all flows; 'flows'/'nodes' restart only what changed; 'reload' re-reads from storage). Requires HA_ALLOW_WRITE=true and HA_ALLOW_CONFIG_WRITE=true.",
			inputSchema: {
				flows: z
					.array(z.record(z.unknown()))
					.describe("The complete flow config: an array of Node-RED node objects (tabs, nodes and config nodes)."),
				rev: z
					.string()
					.optional()
					.describe("Revision from nodered_get_flows, for optimistic concurrency."),
				deployment_type: z
					.enum(["full", "flows", "nodes", "reload"])
					.optional()
					.describe("How Node-RED applies the deploy. Defaults to 'full'.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ flows, rev, deployment_type }) =>
			runTool(ctx.logger, "nodered_set_flows", async () => {
				const refusal = guardConfigWrite();
				if (refusal) {
					return errorResult(refusal);
				}
				const result = await ctx.nodered.setFlows(flows, {
					rev,
					deploymentType: deployment_type
				});
				return jsonResult({ deployed: true, result });
			})
	);
}

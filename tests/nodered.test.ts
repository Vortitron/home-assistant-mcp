import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createNodeRedClient, NodeRedError, type NodeRedClient } from "../src/nodered/client.js";
import type { HaRestClient } from "../src/ha/restClient.js";
import type { HaWsClient } from "../src/ha/wsClient.js";
import { createEsphomeDashboardClient } from "../src/esphome/dashboardClient.js";
import { createVomeHomeClient, type VomeHomeClient } from "../src/vomehome/client.js";
import { createInstanceManager } from "../src/vomehome/instances.js";
import { registerNodeRedTools } from "../src/tools/nodered.js";
import type { ToolContext } from "../src/tools/helpers.js";

const logger = createLogger("error");

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" }
	});
}

function enabledClient(env: Record<string, string> = {}): NodeRedClient {
	const config = loadConfig({
		HA_URL: "http://ha.local:8123",
		HA_TOKEN: "t",
		NODERED_URL: "http://nr.local:1880",
		...env
	});
	return createNodeRedClient(config, logger);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createNodeRedClient", () => {
	it("is disabled without a URL and points the user at NODERED_URL", async () => {
		const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "t" });
		const client = createNodeRedClient(config, logger);
		expect(client.isEnabled()).toBe(false);
		await expect(client.getFlows()).rejects.toMatchObject({ name: "NodeRedError" });
		await expect(client.getFlows()).rejects.toThrow(/NODERED_URL/);
	});

	it("gets flows with the v2 header and unwraps { flows, rev }", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ rev: "abc123", flows: [{ id: "tab1", type: "tab", label: "Home" }] })
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await enabledClient().getFlows();

		expect(result.rev).toBe("abc123");
		expect(result.flows).toEqual([{ id: "tab1", type: "tab", label: "Home" }]);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("http://nr.local:1880/flows");
		expect((init as RequestInit).headers).toMatchObject({ "Node-RED-API-Version": "v2" });
	});

	it("sends a bearer token when NODERED_TOKEN is set", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ flows: [], rev: "r" }));
		vi.stubGlobal("fetch", fetchMock);

		await enabledClient({ NODERED_TOKEN: "tok-123" }).getFlows();

		const [, init] = fetchMock.mock.calls[0]!;
		expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok-123" });
	});

	it("exchanges username/password for a token via /auth/token, then caches it", async () => {
		// A fresh Response per call: a Response body can only be read once.
		const fetchMock = vi.fn(async (url: string) =>
			url.endsWith("/auth/token")
				? jsonResponse({ access_token: "minted", token_type: "Bearer" })
				: jsonResponse({ flows: [], rev: "r" })
		);
		vi.stubGlobal("fetch", fetchMock);

		const client = enabledClient({ NODERED_USERNAME: "admin", NODERED_PASSWORD: "pw" });
		await client.getFlows();
		await client.getFlows();

		// First call mints a token; both flow calls reuse it (3 calls total, 1 token fetch).
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const tokenCalls = fetchMock.mock.calls.filter((call) =>
			(call[0] as string).endsWith("/auth/token")
		);
		expect(tokenCalls).toHaveLength(1);
		expect((tokenCalls[0]![1] as RequestInit).method).toBe("POST");
		const flowCall = fetchMock.mock.calls.find((call) => (call[0] as string).endsWith("/flows"))!;
		expect((flowCall[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer minted" });
	});

	it("POSTs full flows with the deployment-type header and rev in the body", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ rev: "new-rev" }));
		vi.stubGlobal("fetch", fetchMock);

		await enabledClient().setFlows([{ id: "tab1", type: "tab" }], {
			rev: "old-rev",
			deploymentType: "flows"
		});

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("http://nr.local:1880/flows");
		expect((init as RequestInit).method).toBe("POST");
		expect((init as RequestInit).headers).toMatchObject({
			"Node-RED-API-Version": "v2",
			"Node-RED-Deployment-Type": "flows"
		});
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			flows: [{ id: "tab1", type: "tab" }],
			rev: "old-rev"
		});
	});

	it("defaults the deployment type to 'full'", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ rev: "r" }));
		vi.stubGlobal("fetch", fetchMock);
		await enabledClient().setFlows([]);
		const [, init] = fetchMock.mock.calls[0]!;
		expect((init as RequestInit).headers).toMatchObject({ "Node-RED-Deployment-Type": "full" });
	});

	it("throws NodeRedError carrying status and body on non-2xx", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(enabledClient().getFlows()).rejects.toMatchObject({
			name: "NodeRedError",
			status: 401,
			body: "nope"
		});
	});
});

// --- Tool-layer tests -------------------------------------------------------

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

class FakeServer {
	readonly tools = new Map<string, Handler>();
	registerTool(name: string, _config: unknown, handler: Handler): void {
		this.tools.set(name, handler);
	}
	async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
		const handler = this.tools.get(name);
		if (!handler) {
			throw new Error(`tool not registered: ${name}`);
		}
		return handler(args, {});
	}
}

function textOf(result: CallToolResult): string {
	const first = result.content[0];
	return first && first.type === "text" ? first.text : "";
}

function buildHarness(
	options: { env?: Record<string, string>; nodered?: Partial<NodeRedClient> } = {}
): FakeServer {
	const config = loadConfig({
		HA_URL: "http://ha.local:8123",
		HA_TOKEN: "tok",
		NODERED_URL: "http://nr.local:1880",
		...options.env
	});
	const mockRest = {} as unknown as HaRestClient;
	const ctx: ToolContext = {
		config,
		logger,
		rest: mockRest,
		ws: {} as unknown as HaWsClient,
		esphome: createEsphomeDashboardClient(config, logger),
		nodered: (options.nodered ?? createNodeRedClient(config, logger)) as NodeRedClient,
		vomehome: createVomeHomeClient(config, logger) as VomeHomeClient,
		instances: createInstanceManager(config, logger, mockRest)
	};
	const server = new FakeServer();
	registerNodeRedTools(server as unknown as McpServer, ctx);
	return server;
}

const writesOn = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

describe("nodered tools when not configured", () => {
	it("returns a helpful error pointing at NODERED_URL", async () => {
		const server = buildHarness({ env: { NODERED_URL: "" } });
		const result = await server.call("nodered_get_flows");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/NODERED_URL/);
	});
});

describe("nodered write guard", () => {
	it("refuses nodered_set_flows when writes are disabled", async () => {
		const setFlows = vi.fn();
		const server = buildHarness({ nodered: { setFlows } });
		const result = await server.call("nodered_set_flows", { flows: [] });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/HA_ALLOW_WRITE/);
		expect(setFlows).not.toHaveBeenCalled();
	});

	it("refuses when HA_ALLOW_WRITE is on but HA_ALLOW_CONFIG_WRITE is off", async () => {
		const updateFlow = vi.fn();
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, nodered: { updateFlow } });
		const result = await server.call("nodered_update_flow", { id: "tab1", flow: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/HA_ALLOW_CONFIG_WRITE/);
		expect(updateFlow).not.toHaveBeenCalled();
	});

	it("deploys when both write switches are on", async () => {
		const setFlows = vi.fn(async () => ({ rev: "new" }));
		const server = buildHarness({ env: writesOn, nodered: { setFlows } });
		const result = await server.call("nodered_set_flows", {
			flows: [{ id: "t", type: "tab" }],
			deployment_type: "full"
		});
		expect(result.isError).toBeUndefined();
		expect(setFlows).toHaveBeenCalledWith([{ id: "t", type: "tab" }], {
			rev: undefined,
			deploymentType: "full"
		});
		expect(JSON.parse(textOf(result)).deployed).toBe(true);
	});

	it("deletes a flow when writes are enabled", async () => {
		const deleteFlow = vi.fn(async () => undefined);
		const server = buildHarness({ env: writesOn, nodered: { deleteFlow } });
		const result = await server.call("nodered_delete_flow", { id: "tab1" });
		expect(result.isError).toBeUndefined();
		expect(deleteFlow).toHaveBeenCalledWith("tab1");
		expect(JSON.parse(textOf(result)).deleted).toBe(true);
	});
});

describe("nodered read tools", () => {
	it("returns flows from the client", async () => {
		const getFlows = vi.fn(async () => ({ rev: "r1", flows: [{ id: "t", type: "tab" }] }));
		const server = buildHarness({ nodered: { getFlows } });
		const result = await server.call("nodered_get_flows");
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(textOf(result))).toEqual({ rev: "r1", flows: [{ id: "t", type: "tab" }] });
	});

	it("surfaces a client error as a structured tool error", async () => {
		const getFlow = vi.fn(async () => {
			throw new NodeRedError("Node-RED GET /flow/x responded 404 Not Found", 404, "missing");
		});
		const server = buildHarness({ nodered: { getFlow } });
		const result = await server.call("nodered_get_flow", { id: "x" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/404/);
	});
});

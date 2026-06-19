import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import type { HaRestClient } from "../src/ha/restClient.js";
import type { HaWsClient } from "../src/ha/wsClient.js";
import { createEsphomeDashboardClient } from "../src/esphome/dashboardClient.js";
import { createNodeRedClient } from "../src/nodered/client.js";
import { createVomeHomeClient, type VomeHomeClient } from "../src/vomehome/client.js";
import { createInstanceManager } from "../src/vomehome/instances.js";
import { registerAllTools } from "../src/tools/index.js";
import type { ToolContext } from "../src/tools/helpers.js";

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

function jsonOf(result: CallToolResult): any {
	return JSON.parse(textOf(result));
}

const logger = createLogger("error");

function buildHarness(
	options: {
		env?: Record<string, string>;
		rest?: Partial<HaRestClient>;
		ws?: Partial<HaWsClient>;
		vomehome?: Partial<VomeHomeClient>;
	} = {}
): FakeServer {
	const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "tok", ...options.env });
	const mockRest = (options.rest ?? {}) as unknown as HaRestClient;
	const instances = createInstanceManager(config, logger, mockRest);
	const ctx: ToolContext = {
		config,
		logger,
		rest: mockRest,
		ws: (options.ws ?? {}) as unknown as HaWsClient,
		esphome: createEsphomeDashboardClient(config, logger),
		nodered: createNodeRedClient(config, logger),
		vomehome: (options.vomehome ?? createVomeHomeClient(config, logger)) as VomeHomeClient,
		instances
	};
	const server = new FakeServer();
	registerAllTools(server as unknown as McpServer, ctx);
	return server;
}

describe("ha_call_service safety", () => {
	it("refuses when writes are disabled", async () => {
		const callService = vi.fn();
		const server = buildHarness({ rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "light",
			service: "turn_on",
			target: { entity_id: "light.k" }
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/HA_ALLOW_WRITE/);
		expect(callService).not.toHaveBeenCalled();
	});

	it("refuses a denied domain even with writes enabled", async () => {
		const callService = vi.fn();
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "lock",
			service: "unlock",
			target: { entity_id: "lock.front" }
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/deny/i);
		expect(callService).not.toHaveBeenCalled();
	});

	it("blocks cross-domain bypass via homeassistant.turn_on targeting a lock", async () => {
		const callService = vi.fn();
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "homeassistant",
			service: "turn_on",
			data: { entity_id: "lock.front" }
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/lock\.front/);
		expect(callService).not.toHaveBeenCalled();
	});

	it("calls the service for an allowed domain when writes are enabled", async () => {
		const callService = vi.fn(async () => [{ entity_id: "light.k", state: "on", attributes: {} }]);
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "light",
			service: "turn_on",
			target: { entity_id: "light.k" }
		});
		expect(result.isError).toBeUndefined();
		expect(callService).toHaveBeenCalledOnce();
		expect(jsonOf(result).changed_entities).toEqual([{ entity_id: "light.k", state: "on" }]);
	});
});

describe("ha_list_entities", () => {
	const states = [
		{ entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" } },
		{ entity_id: "light.hall", state: "off", attributes: {} },
		{ entity_id: "sensor.temp", state: "21", attributes: { friendly_name: "Temp" } }
	];

	it("filters by domain", async () => {
		const server = buildHarness({ rest: { getStates: async () => states as any } });
		const result = await server.call("ha_list_entities", { domain: "light" });
		const payload = jsonOf(result);
		expect(payload.returned).toBe(2);
		expect(payload.entities.map((entity: any) => entity.entity_id)).toEqual([
			"light.kitchen",
			"light.hall"
		]);
	});

	it("filters by free-text search across id and friendly name", async () => {
		const server = buildHarness({ rest: { getStates: async () => states as any } });
		const result = await server.call("ha_list_entities", { search: "kitchen" });
		expect(jsonOf(result).returned).toBe(1);
	});
});

describe("ha_render_template", () => {
	it("returns the rendered text", async () => {
		const renderTemplate = vi.fn(async () => "true");
		const server = buildHarness({ rest: { renderTemplate } });
		const result = await server.call("ha_render_template", { template: "{{ true }}" });
		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toBe("true");
		expect(renderTemplate).toHaveBeenCalledWith("{{ true }}", undefined);
	});
});

describe("esphome tools when not configured", () => {
	it("returns a helpful error pointing at ESPHOME_DASHBOARD_URL", async () => {
		const server = buildHarness();
		const result = await server.call("esphome_list_devices");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/ESPHOME_DASHBOARD_URL/);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createInstanceManager } from "../src/vomehome/instances.js";
import type { HaRestClient } from "../src/ha/restClient.js";
import type { HaWsClient } from "../src/ha/wsClient.js";
import { createEsphomeDashboardClient } from "../src/esphome/dashboardClient.js";
import { createNodeRedClient } from "../src/nodered/client.js";
import { createVomeHomeClient, type VomeHomeClient } from "../src/vomehome/client.js";
import { registerVomeHomeTools } from "../src/tools/vomehome.js";
import type { ToolContext } from "../src/tools/helpers.js";

const logger = createLogger("error");

const BROKER_ENV = {
	VOMEHOME_API_URL: "https://vome.io",
	VOMEHOME_TOKEN: "vh_test",
	VOMEHOME_INSTANCE_ID: "rly-house",
	HA_ALLOW_WRITE: "true",
	HA_ALLOW_CONFIG_WRITE: "false",
	VOMEHOME_INSTANCES: JSON.stringify([{ id: "sbx-plc", write: true, config: true, label: "PLC sandbox" }])
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// --- config: VOMEHOME_INSTANCES registry ------------------------------------

describe("loadConfig VOMEHOME_INSTANCES", () => {
	it("folds the default instance (VOMEHOME_INSTANCE_ID + HA_ALLOW_*) into the registry", () => {
		const config = loadConfig(BROKER_ENV);
		expect(config.brokered).toBe(true);
		expect(config.vomehome.instanceId).toBe("rly-house");
		const ids = config.vomehome.instances.map((i) => i.id);
		expect(ids).toEqual(["rly-house", "sbx-plc"]);
		const def = config.vomehome.instances.find((i) => i.id === "rly-house")!;
		expect(def).toMatchObject({ write: true, config: false, label: "default" });
		const sbx = config.vomehome.instances.find((i) => i.id === "sbx-plc")!;
		expect(sbx).toMatchObject({ write: true, config: true, label: "PLC sandbox" });
	});

	it("accepts a JSON object map and string-only entries (read-only by default)", () => {
		const config = loadConfig({
			VOMEHOME_API_URL: "https://vome.io",
			VOMEHOME_TOKEN: "t",
			VOMEHOME_INSTANCES: JSON.stringify({ "rly-a": { write: true }, "rly-b": {} })
		});
		const a = config.vomehome.instances.find((i) => i.id === "rly-a")!;
		const b = config.vomehome.instances.find((i) => i.id === "rly-b")!;
		expect(a).toMatchObject({ write: true, config: false });
		expect(b).toMatchObject({ write: false, config: false });
		// No explicit VOMEHOME_INSTANCE_ID -> active is the first declared instance.
		expect(config.vomehome.instanceId).toBe("rly-a");
		expect(config.brokered).toBe(true);
	});

	it("enables brokered mode from VOMEHOME_INSTANCES alone (no VOMEHOME_INSTANCE_ID)", () => {
		const config = loadConfig({
			VOMEHOME_API_URL: "https://vome.io",
			VOMEHOME_TOKEN: "t",
			VOMEHOME_INSTANCES: '[{"id":"only-1","write":true,"config":true}]'
		});
		expect(config.brokered).toBe(true);
		expect(config.vomehome.instanceId).toBe("only-1");
	});

	it("records a parse error for malformed VOMEHOME_INSTANCES", () => {
		const config = loadConfig({
			VOMEHOME_API_URL: "https://vome.io",
			VOMEHOME_TOKEN: "t",
			VOMEHOME_INSTANCE_ID: "rly-1",
			VOMEHOME_INSTANCES: "{not json"
		});
		expect(config.vomehome.instancesError).toMatch(/not valid JSON/);
	});
});

// --- the instance manager ---------------------------------------------------

describe("createInstanceManager (brokered)", () => {
	it("resolves per-instance access and active safety", () => {
		const config = loadConfig(BROKER_ENV);
		const mgr = createInstanceManager(config, logger);
		expect(mgr.brokered).toBe(true);
		expect(mgr.activeId()).toBe("rly-house");
		// Active (house): write yes, config no.
		expect(mgr.currentSafety()).toMatchObject({ allowWrite: true, allowConfigWrite: false });
		// Per-instance lookups.
		expect(mgr.access("sbx-plc")).toMatchObject({ write: true, config: true });
		// Undeclared instance -> read-only, not added to the declared registry.
		expect(mgr.access("ghost")).toMatchObject({ write: false, config: false });
		expect(mgr.has("ghost")).toBe(false);
		// Global deny-list is preserved across instances.
		expect(mgr.safetyFor("sbx-plc").denyDomains).toContain("lock");
	});

	it("switches the active instance and read-only-grants undeclared ones", () => {
		const mgr = createInstanceManager(loadConfig(BROKER_ENV), logger);
		const target = mgr.use("sbx-plc");
		expect(target).toMatchObject({ id: "sbx-plc", inRegistry: true });
		expect(mgr.currentSafety()).toMatchObject({ allowWrite: true, allowConfigWrite: true });

		const ghost = mgr.use("ghost");
		expect(ghost.inRegistry).toBe(false);
		expect(mgr.activeId()).toBe("ghost");
		expect(mgr.currentSafety()).toMatchObject({ allowWrite: false, allowConfigWrite: false });
	});

	it("grants full access to a created instance and makes it active", () => {
		const mgr = createInstanceManager(loadConfig(BROKER_ENV), logger);
		const access = mgr.registerCreated("sbx-new", "Fresh sandbox");
		expect(access).toMatchObject({ write: true, config: true, created: true });
		expect(mgr.activeId()).toBe("sbx-new");
		expect(mgr.has("sbx-new")).toBe(true);
		expect(mgr.currentSafety()).toMatchObject({ allowWrite: true, allowConfigWrite: true });
	});

	it("routes the rest proxy to whichever instance is active", async () => {
		const fetchMock = vi.fn(async () => jsonResponse([{ entity_id: "light.k", state: "on", attributes: {} }]));
		vi.stubGlobal("fetch", fetchMock);
		const mgr = createInstanceManager(loadConfig(BROKER_ENV), logger);

		await mgr.rest.getStates();
		expect(fetchMock.mock.calls[0]![0]).toBe("https://vome.io/api/v1/instances/rly-house/ha/states");

		mgr.use("sbx-plc");
		await mgr.rest.getStates();
		expect(fetchMock.mock.calls[1]![0]).toBe("https://vome.io/api/v1/instances/sbx-plc/ha/states");
	});
});

describe("createInstanceManager (direct)", () => {
	it("ignores instance ids and uses the global safety + single client", () => {
		const config = loadConfig({ HA_URL: "http://ha:8123", HA_TOKEN: "t", HA_ALLOW_WRITE: "true" });
		const direct = { getStates: async () => [] } as unknown as HaRestClient;
		const mgr = createInstanceManager(config, logger, direct);
		expect(mgr.brokered).toBe(false);
		expect(mgr.access("anything")).toMatchObject({ write: true, config: false });
		expect(mgr.currentRest()).toBe(direct);
	});
});

// --- the brokered vomehome tools --------------------------------------------

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

function jsonOf(result: CallToolResult): any {
	const first = result.content[0];
	return JSON.parse(first && first.type === "text" ? first.text : "");
}

function brokeredHarness(vomehome: Partial<VomeHomeClient>, env: Record<string, string> = {}): FakeServer {
	const config = loadConfig({ ...BROKER_ENV, VOMEHOME_ALLOW_CREATE: "true", HA_ALLOW_WRITE: "true", ...env });
	const instances = createInstanceManager(config, logger);
	const ctx: ToolContext = {
		config,
		logger,
		rest: instances.rest,
		ws: {} as unknown as HaWsClient,
		esphome: createEsphomeDashboardClient(config, logger),
		nodered: createNodeRedClient(config, logger),
		vomehome: { ...createVomeHomeClient(config, logger), ...vomehome } as VomeHomeClient,
		instances
	};
	const server = new FakeServer();
	registerVomeHomeTools(server as unknown as McpServer, ctx);
	return server;
}

describe("vomehome multi-instance tools", () => {
	it("lists instances with active marker and per-instance client access", async () => {
		const listInstances = vi.fn(async () => [
			{ id: "rly-house", name: "House" },
			{ id: "sbx-plc", name: "PLC sandbox" }
		]);
		const server = brokeredHarness({ listInstances });
		const payload = jsonOf(await server.call("vomehome_list_instances"));
		expect(payload.active_instance).toBe("rly-house");
		const house = payload.instances.find((i: any) => i.id === "rly-house");
		const sbx = payload.instances.find((i: any) => i.id === "sbx-plc");
		expect(house).toMatchObject({ active: true, client_access: { write: true, config: false, declared: true } });
		expect(sbx).toMatchObject({ active: false, client_access: { write: true, config: true, declared: true } });
	});

	it("switches the active instance via vomehome_use_instance", async () => {
		const server = brokeredHarness({});
		const payload = jsonOf(await server.call("vomehome_use_instance", { instance_id: "sbx-plc" }));
		expect(payload).toMatchObject({
			active_instance: "sbx-plc",
			declared: true,
			client_access: { write: true, config: true }
		});
	});

	it("flags an undeclared target as read-only when switching", async () => {
		const server = brokeredHarness({});
		const payload = jsonOf(await server.call("vomehome_use_instance", { instance_id: "ghost" }));
		expect(payload).toMatchObject({ active_instance: "ghost", declared: false, client_access: { write: false } });
	});

	it("grants full access to a created instance and makes it active", async () => {
		const createInstance = vi.fn(async () => ({ id: "sbx-new", name: "Sandbox", status: "creating" }));
		const server = brokeredHarness({ createInstance });
		const payload = jsonOf(await server.call("vomehome_create_instance", { name: "Sandbox" }));
		expect(payload).toMatchObject({
			created: true,
			active_instance: "sbx-new",
			client_access: { write: true, config: true }
		});
	});

	it("refuses to switch instances in direct mode", async () => {
		const config = loadConfig({ HA_URL: "http://ha:8123", HA_TOKEN: "t", VOMEHOME_TOKEN: "vh" });
		const instances = createInstanceManager(config, logger, { getStates: async () => [] } as unknown as HaRestClient);
		const ctx: ToolContext = {
			config,
			logger,
			rest: instances.rest,
			ws: {} as unknown as HaWsClient,
			esphome: createEsphomeDashboardClient(config, logger),
			nodered: createNodeRedClient(config, logger),
			vomehome: createVomeHomeClient(config, logger),
			instances
		};
		const server = new FakeServer();
		registerVomeHomeTools(server as unknown as McpServer, ctx);
		const result = await server.call("vomehome_use_instance", { instance_id: "x" });
		expect(result.isError).toBe(true);
	});
});

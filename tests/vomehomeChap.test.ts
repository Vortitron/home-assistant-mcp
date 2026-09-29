import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createVomeHomeClient, type VomeHomeClient } from "../src/vomehome/client.js";
import type { HaRestClient } from "../src/ha/restClient.js";
import type { HaWsClient } from "../src/ha/wsClient.js";
import { createUnavailableEsphomeClient } from "../src/esphome/client.js";
import { createNodeRedClient } from "../src/nodered/client.js";
import { createInstanceManager } from "../src/vomehome/instances.js";
import { registerVomeHomeChapTools } from "../src/tools/vomehomeChap.js";
import type { ToolContext } from "../src/tools/helpers.js";

/*
 * CHAP for agents (owner, 29 Sept 2026): "anything Vome side needs both human
 * and agent ability". Each tool is one CHAP page action through the portal API.
 */

const logger = createLogger("error");
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

class FakeServer {
	readonly tools = new Map<string, Handler>();
	registerTool(name: string, _config: unknown, handler: Handler): void {
		this.tools.set(name, handler);
	}
	async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
		const handler = this.tools.get(name);
		if (!handler) throw new Error(`tool not registered: ${name}`);
		return handler(args, {});
	}
}

function textOf(result: CallToolResult): string {
	const first = result.content[0];
	return first && first.type === "text" ? first.text : "";
}

function harness(env: Record<string, string> = {}, vomehome?: Partial<VomeHomeClient>): FakeServer {
	const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "tok", VOMEHOME_TOKEN: "pat", ...env });
	const instances = createInstanceManager(config, logger, {} as unknown as HaRestClient);
	const ctx: ToolContext = {
		config,
		logger,
		rest: instances.rest,
		ws: {} as unknown as HaWsClient,
		esphome: createUnavailableEsphomeClient(),
		nodered: createNodeRedClient(config, logger),
		vomehome: (vomehome ?? createVomeHomeClient(config, logger)) as VomeHomeClient,
		instances
	};
	const server = new FakeServer();
	registerVomeHomeChapTools(server as unknown as McpServer, ctx);
	return server;
}

const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("vomehome CHAP client", () => {
	it("GETs the status and POSTs actions to the instance's chap path", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "t", VOMEHOME_TOKEN: "pat" });
		const client = createVomeHomeClient(config, logger);
		await client.chap("home-1");
		await client.chap("home-1", "standby", "POST", { install_id: "spare" });
		const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
		expect(calls[0][0]).toMatch(/\/api\/v1\/instances\/home-1\/chap$/);
		expect(calls[0][1].method).toBe("GET");
		expect(calls[1][0]).toMatch(/\/api\/v1\/instances\/home-1\/chap\/standby$/);
		expect(JSON.parse(String(calls[1][1].body))).toEqual({ install_id: "spare" });
	});

	it("returns a refusal's reason instead of throwing", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "Your standby is running the home: switch back first." }, 409)));
		const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "t", VOMEHOME_TOKEN: "pat" });
		const result = await createVomeHomeClient(config, logger).chap("home-1", "standby", "DELETE");
		expect(result).toEqual({ ok: false, error: "Your standby is running the home: switch back first." });
	});
});

describe("vomehome CHAP tools", () => {
	it("registers one tool per CHAP page action", () => {
		const server = harness();
		expect([...server.tools.keys()].sort()).toEqual([
			"vomehome_chap_enrol",
			"vomehome_chap_link_standby",
			"vomehome_chap_pair",
			"vomehome_chap_set_home_address",
			"vomehome_chap_standby_candidates",
			"vomehome_chap_status",
			"vomehome_chap_switch",
			"vomehome_chap_switch_back",
			"vomehome_chap_unlink_standby"
		]);
	});

	it("reads without write access", async () => {
		const chap = vi.fn(async () => ({ enrolled: true, actions: ["switch"] }));
		const result = await harness({}, { chap }).call("vomehome_chap_status", { instance_id: "home-1" });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(textOf(result)).actions).toEqual(["switch"]);
	});

	it("refuses changes when writes are off locally", async () => {
		const chap = vi.fn();
		const result = await harness({}, { chap }).call("vomehome_chap_link_standby", { instance_id: "home-1", install_id: "spare" });
		expect(result.isError).toBe(true);
		expect(chap).not.toHaveBeenCalled();
	});

	it("links a standby with the install id", async () => {
		const chap = vi.fn(async () => ({ ok: true, next: "pair" }));
		const result = await harness(WRITE, { chap }).call("vomehome_chap_link_standby", { instance_id: "home-1", install_id: "spare" });
		expect(result.isError).toBeUndefined();
		expect(chap).toHaveBeenCalledWith("home-1", "standby", "POST", { install_id: "spare" });
	});

	it("says why VomeHome refused", async () => {
		const chap = vi.fn(async () => ({ ok: false, error: "This home already has a standby. Remove it first." }));
		const result = await harness(WRITE, { chap }).call("vomehome_chap_link_standby", { instance_id: "home-1", install_id: "spare" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/already has a standby/);
	});

	it("switches back at once only when asked to", async () => {
		const chap = vi.fn(async () => ({ ok: true }));
		const server = harness(WRITE, { chap });
		await server.call("vomehome_chap_switch_back", { instance_id: "home-1" });
		await server.call("vomehome_chap_switch_back", { instance_id: "home-1", now: true });
		expect(chap).toHaveBeenNthCalledWith(1, "home-1", "switch-back", "POST", {});
		expect(chap).toHaveBeenNthCalledWith(2, "home-1", "switch-back", "POST", { now: true });
	});
});

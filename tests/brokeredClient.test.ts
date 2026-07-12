import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createBrokeredHaRestClient, createBrokeredWsClient, createUnavailableWsClient } from "../src/ha/brokeredClient.js";

const logger = createLogger("error");

const BROKER_ENV = {
	VOMEHOME_API_URL: "https://vome.io",
	VOMEHOME_TOKEN: "vh_test",
	VOMEHOME_INSTANCE_ID: "srv-1"
};

function client() {
	return createBrokeredHaRestClient(loadConfig(BROKER_ENV), logger);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" }
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("brokered mode detection", () => {
	it("is on when a VomeHome token + instance are set and HA_TOKEN is absent", () => {
		const config = loadConfig(BROKER_ENV);
		expect(config.brokered).toBe(true);
	});

	it("is off (direct wins) when HA_TOKEN is also present", () => {
		const config = loadConfig({ ...BROKER_ENV, HA_TOKEN: "direct" });
		expect(config.brokered).toBe(false);
	});

	it("requires an instance id in brokered mode", () => {
		// no instance id, no HA creds -> falls back to direct validation
		const config = loadConfig({ VOMEHOME_API_URL: "https://vome.io", VOMEHOME_TOKEN: "vh_x" });
		expect(config.brokered).toBe(false);
	});
});

describe("createBrokeredHaRestClient", () => {
	it("GETs states through the broker with the VomeHome token", async () => {
		const fetchMock = vi.fn(async () => jsonResponse([{ entity_id: "light.k", state: "on", attributes: {} }]));
		vi.stubGlobal("fetch", fetchMock);

		const states = await client().getStates();

		expect(states).toHaveLength(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/srv-1/ha/states");
		expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer vh_test" });
	});

	it("POSTs service calls to the broker endpoint with a merged body", async () => {
		const fetchMock = vi.fn(async () => jsonResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		await client().callService("light", "turn_on", { brightness_pct: 60 }, { entity_id: "light.k" });

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/srv-1/ha/services/light/turn_on");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			brightness_pct: 60,
			entity_id: "light.k"
		});
	});

	it("renders templates as text via the broker", async () => {
		const fetchMock = vi.fn(async () => new Response("4", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const rendered = await client().renderTemplate("{{ 2 + 2 }}");

		expect(rendered).toBe("4");
		const [url] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/srv-1/ha/template");
	});

	it("surfaces a server-side policy denial (403) as a clear HaApiError", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "domain(s) denied by policy: lock", denied_domains: ["lock"] }, 403)
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(client().callService("lock", "unlock", {}, { entity_id: "lock.front" })).rejects.toMatchObject({
			name: "HaApiError",
			status: 403
		});
		await expect(
			client().callService("lock", "unlock", {}, { entity_id: "lock.front" })
		).rejects.toThrow(/denied by policy/);
	});

	it("reads an automation's config through the broker", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ alias: "Test", trigger: [], action: [] }));
		vi.stubGlobal("fetch", fetchMock);

		const config = await client().getAutomationConfig("1744274343050");

		expect(config).toMatchObject({ alias: "Test" });
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe(
			"https://vome.io/api/v1/instances/srv-1/ha/config/automation/config/1744274343050"
		);
		expect((init as RequestInit).method ?? "GET").toBe("GET");
	});

	it("creates/updates an automation via a POST of the config body", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ result: "ok" }));
		vi.stubGlobal("fetch", fetchMock);

		const body = { alias: "MCP test", trigger: [], action: [] };
		const result = await client().upsertAutomationConfig("mcp_test", body);

		expect(result).toEqual({ result: "ok" });
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/srv-1/ha/config/automation/config/mcp_test");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual(body);
	});

	it("rejects a non-object automation config without calling the broker", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ result: "ok" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			client().upsertAutomationConfig("x", [] as unknown as Record<string, unknown>)
		).rejects.toThrow(/must be a JSON object/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("deletes an automation via the broker", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ result: "ok" }));
		vi.stubGlobal("fetch", fetchMock);

		await client().deleteAutomationConfig("mcp_test");

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/srv-1/ha/config/automation/config/mcp_test");
		expect((init as RequestInit).method).toBe("DELETE");
	});

	it("validates the running config via the broker", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ result: "valid", errors: null }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await client().checkConfig();

		expect(result).toMatchObject({ result: "valid" });
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/srv-1/ha/check_config");
		expect((init as RequestInit).method).toBe("POST");
	});

	it("POSTs allowlisted WebSocket commands to /ha/ws/command", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ result: [{ url_path: "lovelace" }] }));
		vi.stubGlobal("fetch", fetchMock);

		const dashboards = await client().sendWsCommand<unknown[]>({
			type: "lovelace/dashboards/list"
		});

		expect(dashboards).toEqual([{ url_path: "lovelace" }]);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/srv-1/ha/ws/command");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			type: "lovelace/dashboards/list"
		});
	});

	it("GETs error log through the broker", async () => {
		const fetchMock = vi.fn(async () => new Response("ERROR: test", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const log = await client().getErrorLog();

		expect(log).toBe("ERROR: test");
		const [url] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/srv-1/ha/error_log");
	});

	it("GETs history with entity filter query params", async () => {
		const fetchMock = vi.fn(async () => jsonResponse([[]]));
		vi.stubGlobal("fetch", fetchMock);

		await client().getHistory({ entityIds: ["light.kitchen", "sensor.temp"] });

		const [url] = fetchMock.mock.calls[0]!;
		expect(url).toContain("/ha/history/period");
		expect(url).toContain("filter_entity_id=light.kitchen%2Csensor.temp");
	});

	it("throws a helpful error for raw request()", async () => {
		await expect(client().request("/api/states")).rejects.toThrow(/brokered mode/);
	});
});

describe("createBrokeredWsClient", () => {
	it("lists areas via sendWsCommand on the REST client", async () => {
		const rest = {
			sendWsCommand: vi.fn(async () => [{ area_id: "kitchen", name: "Kitchen" }])
		} as unknown as ReturnType<typeof client>;
		const ws = createBrokeredWsClient(() => rest);
		const areas = await ws.listAreas();
		expect(areas).toHaveLength(1);
		expect(rest.sendWsCommand).toHaveBeenCalledWith({ type: "config/area_registry/list" });
	});
});

describe("createUnavailableWsClient", () => {
	it("throws for registry calls and resolves close()", async () => {
		const ws = createUnavailableWsClient();
		await expect(ws.listAreas()).rejects.toThrow(/brokered mode/);
		await expect(ws.listDevices()).rejects.toThrow(/brokered mode/);
		await expect(ws.close()).resolves.toBeUndefined();
	});
});

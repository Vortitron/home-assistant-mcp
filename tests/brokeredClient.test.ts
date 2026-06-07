import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createBrokeredHaRestClient, createUnavailableWsClient } from "../src/ha/brokeredClient.js";

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

	it("throws a helpful error for features the broker does not expose", async () => {
		await expect(client().getErrorLog()).rejects.toThrow(/not available in VomeHome brokered mode/);
		await expect(client().getAutomationConfig("x")).rejects.toThrow(/brokered mode/);
		await expect(client().request("/api/states")).rejects.toThrow(/brokered mode/);
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

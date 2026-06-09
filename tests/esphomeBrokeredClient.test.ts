import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createBrokeredEsphomeDashboardClient } from "../src/esphome/brokeredDashboardClient.js";

const logger = createLogger("error");

const BROKER_ENV = {
	VOMEHOME_API_URL: "https://vome.io",
	VOMEHOME_TOKEN: "vh_test",
	VOMEHOME_INSTANCE_ID: "rly-1"
};

function client() {
	return createBrokeredEsphomeDashboardClient(loadConfig(BROKER_ENV), logger);
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

describe("brokered ESPHome detection", () => {
	it("is enabled + brokered when brokering HA and no dashboard URL is set", () => {
		const config = loadConfig(BROKER_ENV);
		expect(config.esphome.enabled).toBe(true);
		expect(config.esphome.brokered).toBe(true);
	});

	it("uses the direct dashboard (not brokered) when ESPHOME_DASHBOARD_URL is set", () => {
		const config = loadConfig({ ...BROKER_ENV, ESPHOME_DASHBOARD_URL: "http://esp:6052" });
		expect(config.esphome.enabled).toBe(true);
		expect(config.esphome.brokered).toBe(false);
	});

	it("is disabled when neither brokered nor a dashboard URL is configured", () => {
		const config = loadConfig({ HA_URL: "http://ha:8123", HA_TOKEN: "t" });
		expect(config.esphome.enabled).toBe(false);
		expect(config.esphome.brokered).toBe(false);
	});
});

describe("createBrokeredEsphomeDashboardClient", () => {
	it("lists devices through the broker with the VomeHome token", async () => {
		const fetchMock = vi.fn(async () => jsonResponse([{ name: "lr", configuration: "lr.yaml" }]));
		vi.stubGlobal("fetch", fetchMock);

		const devices = (await client().listDevices()) as Array<{ name: string }>;

		expect(devices[0]!.name).toBe("lr");
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/rly-1/esphome/devices");
		expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer vh_test" });
	});

	it("reads a configuration's YAML from the {yaml} envelope", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ configuration: "lr.yaml", yaml: "esphome:\n  name: lr\n" })
		);
		vi.stubGlobal("fetch", fetchMock);

		const yaml = await client().getConfig("lr.yaml");

		expect(yaml).toBe("esphome:\n  name: lr\n");
		const [url] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/rly-1/esphome/config?configuration=lr.yaml");
	});

	it("POSTs YAML on save", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ configuration: "lr.yaml", saved: true }));
		vi.stubGlobal("fetch", fetchMock);

		await client().saveConfig("lr.yaml", "esphome:\n  name: lr\n");

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/rly-1/esphome/config?configuration=lr.yaml");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({ yaml: "esphome:\n  name: lr\n" });
	});

	it("rejects streaming build commands with a direct-dashboard hint", async () => {
		await expect(
			client().runCommand({ command: "compile", configuration: "lr.yaml" })
		).rejects.toThrow(/ESPHOME_DASHBOARD_URL/);
	});

	it("surfaces a broker error body", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "Home Assistant is offline (no relay connection)." }, 502)
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(client().listDevices()).rejects.toThrow(/offline/);
	});
});

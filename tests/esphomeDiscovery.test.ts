import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { discoverDashboardUrl } from "../src/esphome/discovery.js";
import { createResolvingEsphomeClient } from "../src/esphome/resolvingClient.js";
import type { EsphomeDashboardClient } from "../src/esphome/dashboardClient.js";

const logger = createLogger("error");

const DIRECT_ENV = { HA_URL: "http://ha.local:8123", HA_TOKEN: "t", HA_ALLOW_WRITE: "true" };
const BROKER_ENV = {
	VOMEHOME_API_URL: "https://vome.io",
	VOMEHOME_TOKEN: "vh_test",
	VOMEHOME_INSTANCE_ID: "rly-1"
};

/**
 * A stand-in Home Assistant WebSocket. `supervisor` is the add-on info the
 * Supervisor would return; null makes the Supervisor look absent, which is the
 * container-only Home Assistant case.
 */
function fakeWs(options: { internalUrl?: string; supervisorPort?: number | null } = {}) {
	return vi.fn(async (command: Record<string, unknown>) => {
		if (command.type === "get_config") {
			return { internal_url: options.internalUrl ?? null, external_url: null };
		}
		if (command.type === "supervisor/api") {
			if (options.supervisorPort === undefined || options.supervisorPort === null) {
				throw new Error("Supervisor not available");
			}
			if (command.endpoint === "/addons") {
				return { data: { addons: [{ slug: "5c53de3b_esphome", name: "ESPHome Device Builder" }] } };
			}
			return { data: { network: { "6052/tcp": options.supervisorPort } } };
		}
		throw new Error(`unexpected command ${String(command.type)}`);
	});
}

/** Answer `/version` at exactly the given URLs; everything else is unreachable. */
function fetchAnswering(...reachable: string[]) {
	return vi.fn(async (input: unknown) => {
		const url = String(input);
		if (reachable.some((base) => url === `${base}/version`)) {
			return new Response(JSON.stringify({ version: "2026.8.2" }), { status: 200 });
		}
		throw new Error("ECONNREFUSED");
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("discoverDashboardUrl", () => {
	it("prefers the port the Supervisor says the add-on publishes", async () => {
		vi.stubGlobal("fetch", fetchAnswering("http://ha.local:6789"));
		const outcome = await discoverDashboardUrl({
			config: loadConfig(DIRECT_ENV),
			logger,
			sendCommand: fakeWs({ supervisorPort: 6789 })
		});
		expect(outcome.url).toBe("http://ha.local:6789");
		expect(outcome.source).toContain("supervisor");
	});

	it("falls back to ESPHome's default port when there is no Supervisor", async () => {
		vi.stubGlobal("fetch", fetchAnswering("http://ha.local:6052"));
		const outcome = await discoverDashboardUrl({
			config: loadConfig(DIRECT_ENV),
			logger,
			sendCommand: fakeWs()
		});
		expect(outcome.url).toBe("http://ha.local:6052");
	});

	it("uses the URL Home Assistant reports for itself when HA_URL is unset", async () => {
		// The brokered case: no direct HA URL exists, so the only way to learn the
		// home's address is to ask the home.
		vi.stubGlobal("fetch", fetchAnswering("http://192.168.1.50:6052"));
		const outcome = await discoverDashboardUrl({
			config: loadConfig(BROKER_ENV),
			logger,
			sendCommand: fakeWs({ internalUrl: "http://192.168.1.50:8123" })
		});
		expect(outcome.url).toBe("http://192.168.1.50:6052");
	});

	it("reports every address it tried when nothing answers", async () => {
		vi.stubGlobal("fetch", fetchAnswering());
		const outcome = await discoverDashboardUrl({
			config: loadConfig(DIRECT_ENV),
			logger,
			sendCommand: fakeWs({ supervisorPort: 6789 })
		});
		expect(outcome.url).toBeNull();
		expect(outcome.attempts.map((a) => a.url)).toEqual([
			"http://ha.local:6789",
			"http://ha.local:6052"
		]);
		expect(outcome.attempts.every((a) => !a.ok)).toBe(true);
	});

	it("says so plainly when no host is known at all", async () => {
		vi.stubGlobal("fetch", fetchAnswering());
		const outcome = await discoverDashboardUrl({
			config: loadConfig(BROKER_ENV),
			logger,
			sendCommand: fakeWs()
		});
		expect(outcome.url).toBeNull();
		expect(outcome.attempts).toEqual([]);
		expect(outcome.note).toMatch(/No Home Assistant host is known/);
	});
});

describe("createResolvingEsphomeClient", () => {
	const brokeredStub = (): EsphomeDashboardClient => ({
		isEnabled: () => true,
		listDevices: async () => [{ name: "relayed" }],
		getVersion: async () => ({}),
		getConfig: async () => "",
		saveConfig: async () => undefined,
		runCommand: async () => {
			throw new Error("brokered runCommand should never be reached");
		}
	});

	it("uses a configured dashboard without probing the network", async () => {
		const fetchMock = fetchAnswering();
		vi.stubGlobal("fetch", fetchMock);
		const sendCommand = fakeWs();
		const client = createResolvingEsphomeClient({
			config: loadConfig({ ...DIRECT_ENV, ESPHOME_DASHBOARD_URL: "http://esp:6052" }),
			logger,
			sendCommand,
			brokered: null,
			activeId: () => ""
		});

		const status = await client.describe();

		expect(status.mode).toBe("direct-configured");
		expect(status.url).toBe("http://esp:6052");
		expect(status.streaming).toBe(true);
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it("treats a discovered dashboard as fully capable", async () => {
		vi.stubGlobal("fetch", fetchAnswering("http://ha.local:6052"));
		const client = createResolvingEsphomeClient({
			config: loadConfig(DIRECT_ENV),
			logger,
			sendCommand: fakeWs(),
			brokered: null,
			activeId: () => ""
		});

		const status = await client.describe();

		expect(status.mode).toBe("direct-discovered");
		expect(status.streaming).toBe(true);
	});

	it("prefers the relay over a dashboard it could reach directly", async () => {
		// The whole point of brokering: going direct would work here, and would
		// skip the portal's scope checks and audit log doing it. An agent whose
		// token was revoked must not still be able to flash a device just because
		// it shares a network with the home.
		vi.stubGlobal("fetch", fetchAnswering("http://192.168.1.50:6052"));
		const sendCommand = fakeWs({ internalUrl: "http://192.168.1.50:8123" });
		const client = createResolvingEsphomeClient({
			config: loadConfig(BROKER_ENV),
			logger,
			sendCommand,
			brokered: brokeredStub(),
			activeId: () => "rly-1"
		});

		const status = await client.describe();

		expect(status.mode).toBe("brokered");
		expect(status.streaming).toBe(true);
		// It should not even go looking for a dashboard to bypass the relay with.
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it("runs build commands through the relay when brokered", async () => {
		vi.stubGlobal("fetch", fetchAnswering());
		const brokered = brokeredStub();
		const runCommand = vi.fn(async () => ({
			command: "upload",
			configuration: "lr.yaml",
			exitCode: 0,
			output: "OK",
			truncated: false
		}));
		const client = createResolvingEsphomeClient({
			config: loadConfig(BROKER_ENV),
			logger,
			sendCommand: fakeWs({ internalUrl: "http://192.168.1.50:8123" }),
			brokered: { ...brokered, runCommand },
			activeId: () => "rly-1"
		});

		const result = await client.runCommand({ command: "upload", configuration: "lr.yaml" });

		expect(result.exitCode).toBe(0);
		expect(runCommand).toHaveBeenCalled();
	});

	it("serves reads over the relay too", async () => {
		vi.stubGlobal("fetch", fetchAnswering());
		const client = createResolvingEsphomeClient({
			config: loadConfig(BROKER_ENV),
			logger,
			sendCommand: fakeWs({ internalUrl: "http://192.168.1.50:8123" }),
			brokered: brokeredStub(),
			activeId: () => "rly-1"
		});

		expect((await client.describe()).mode).toBe("brokered");
		expect(await client.listDevices()).toEqual([{ name: "relayed" }]);
	});

	it("re-resolves when the active instance changes", async () => {
		// Otherwise switching homes would keep pointing ESPHome at the previous
		// home's dashboard — a wrong-house flash.
		vi.stubGlobal("fetch", fetchAnswering("http://192.168.1.50:6052"));
		let instance = "rly-1";
		const sendCommand = fakeWs({ internalUrl: "http://192.168.1.50:8123" });
		const client = createResolvingEsphomeClient({
			config: loadConfig(BROKER_ENV),
			logger,
			sendCommand,
			brokered: brokeredStub(),
			activeId: () => instance
		});

		expect((await client.describe()).instance).toBe("rly-1");
		instance = "rly-2";
		expect((await client.describe()).instance).toBe("rly-2");
	});

	it("caches a successful resolution instead of probing on every call", async () => {
		const fetchMock = fetchAnswering("http://ha.local:6052");
		vi.stubGlobal("fetch", fetchMock);
		const client = createResolvingEsphomeClient({
			config: loadConfig(DIRECT_ENV),
			logger,
			sendCommand: fakeWs(),
			brokered: null,
			activeId: () => ""
		});

		await client.describe();
		const probes = fetchMock.mock.calls.length;
		await client.describe();
		await client.describe();

		expect(fetchMock.mock.calls.length).toBe(probes);
	});
});

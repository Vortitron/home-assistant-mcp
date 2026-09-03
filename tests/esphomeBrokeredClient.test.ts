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

function client(activeId: () => string = () => "rly-1") {
	return createBrokeredEsphomeDashboardClient(loadConfig(BROKER_ENV), logger, activeId);
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

	it("stays enabled with a direct HA and no dashboard URL, so discovery can run", () => {
		// The dashboard address no longer has to be configured to be usable:
		// esphome/discovery.ts derives it from the Supervisor and probes it.
		// Gating on ESPHOME_DASHBOARD_URL would switch the tools off before that
		// ever happened, which is what made agents report ESPHome as unavailable.
		const config = loadConfig({ HA_URL: "http://ha:8123", HA_TOKEN: "t" });
		expect(config.esphome.enabled).toBe(true);
		expect(config.esphome.brokered).toBe(false);
	});

	it("is disabled only when there is no route to a home at all", () => {
		const config = loadConfig({});
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

	it("runs a build command as a polled job and returns its output", async () => {
		// Start, then poll from a cursor until the job reports done — the shape
		// that lets a multi-minute compile survive ordinary HTTP timeouts.
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ job_id: "job-1" }))
			.mockResolvedValueOnce(
				jsonResponse({ lines: ["Compiling\n"], cursor: 1, done: false })
			)
			.mockResolvedValueOnce(
				jsonResponse({ lines: ["Done\n"], cursor: 2, done: true, exit_code: 0 })
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await client().runCommand({
			command: "compile",
			configuration: "lr.yaml"
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("Compiling\nDone\n");
		const [startUrl, startInit] = fetchMock.mock.calls[0]!;
		expect(startUrl).toBe("https://vome.io/api/v1/instances/rly-1/esphome/stream");
		expect(JSON.parse((startInit as RequestInit).body as string)).toEqual({
			command: "compile",
			configuration: "lr.yaml"
		});
		expect(String(fetchMock.mock.calls[2]![0])).toContain("cursor=1");
	});

	it("reports a job that ended without an exit code as a failure", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ job_id: "job-1" }))
			.mockResolvedValueOnce(
				jsonResponse({
					lines: [],
					cursor: 0,
					done: true,
					error: "The ESPHome add-on is not running."
				})
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			client().runCommand({ command: "upload", configuration: "lr.yaml" })
		).rejects.toThrow(/add-on is not running/);
	});

	it("cancels the job on the home when it gives up waiting", async () => {
		// Otherwise an abandoned build would keep running on the user's hardware.
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ job_id: "job-1" }))
			// A fresh Response each time: a body can only be read once.
			.mockImplementation(async () => jsonResponse({ lines: [], cursor: 0, done: false }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await client().runCommand({
			command: "compile",
			configuration: "lr.yaml",
			timeoutMs: 600
		});

		expect(result.truncated).toBe(true);
		// Flagged so the tool layer can tell "we stopped watching" apart from
		// "the command failed" — the difference between the two for `logs`.
		expect(result.timedOut).toBe(true);
		const deletes = fetchMock.mock.calls.filter(
			([, init]) => (init as RequestInit | undefined)?.method === "DELETE"
		);
		expect(deletes).toHaveLength(1);
		expect(String(deletes[0]![0])).toContain("/esphome/stream/job-1");
	});

	it("reads pending migrations through the broker", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				migrations_pending: true,
				required: false,
				changes: [{ old: "homeassistant.service", new: "homeassistant.action" }]
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		const report = (await client().getMigrations("lr.yaml")) as { migrations_pending: boolean };

		expect(report.migrations_pending).toBe(true);
		expect(String(fetchMock.mock.calls[0]![0])).toBe(
			"https://vome.io/api/v1/instances/rly-1/esphome/migrations?configuration=lr.yaml"
		);
	});

	it("surfaces a broker error body", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "Home Assistant is offline (no relay connection)." }, 502)
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(client().listDevices()).rejects.toThrow(/offline/);
	});

	it("follows the active instance when it changes between calls", async () => {
		const fetchMock = vi.fn(async () => jsonResponse([]));
		vi.stubGlobal("fetch", fetchMock);
		let active = "rly-1";
		const c = client(() => active);

		await c.listDevices();
		active = "rly-2";
		await c.listDevices();

		expect(fetchMock.mock.calls[0]![0]).toBe(
			"https://vome.io/api/v1/instances/rly-1/esphome/devices"
		);
		expect(fetchMock.mock.calls[1]![0]).toBe(
			"https://vome.io/api/v1/instances/rly-2/esphome/devices"
		);
	});

	it("refuses with a clear error when no instance is active", async () => {
		await expect(client(() => "").listDevices()).rejects.toThrow(/vomehome_use_instance/);
	});
});

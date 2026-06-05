import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createHaRestClient, HaApiError } from "../src/ha/restClient.js";

const logger = createLogger("error");

function client() {
	const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "tok" });
	return createHaRestClient(config, logger);
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

describe("createHaRestClient", () => {
	it("GETs states with the bearer token", async () => {
		const fetchMock = vi.fn(async () => jsonResponse([{ entity_id: "light.k", state: "on", attributes: {} }]));
		vi.stubGlobal("fetch", fetchMock);

		const states = await client().getStates();

		expect(states).toHaveLength(1);
		expect(states[0]?.entity_id).toBe("light.k");
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("http://ha.local:8123/api/states");
		expect((init as RequestInit).method).toBe("GET");
		expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
	});

	it("merges service data and target into the POST body", async () => {
		const fetchMock = vi.fn(async () => jsonResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		await client().callService("light", "turn_on", { brightness_pct: 60 }, { entity_id: "light.k" });

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("http://ha.local:8123/api/services/light/turn_on");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			brightness_pct: 60,
			entity_id: "light.k"
		});
	});

	it("returns rendered template text (not JSON)", async () => {
		const fetchMock = vi.fn(async () => new Response("21.4", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const rendered = await client().renderTemplate("{{ 21.4 }}");

		expect(rendered).toBe("21.4");
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("http://ha.local:8123/api/template");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({ template: "{{ 21.4 }}" });
	});

	it("throws HaApiError carrying status and body on non-2xx", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(client().getConfig()).rejects.toMatchObject({
			name: "HaApiError",
			status: 401,
			body: "nope"
		});
	});

	it("builds history query params", async () => {
		const fetchMock = vi.fn(async () => jsonResponse([[]]));
		vi.stubGlobal("fetch", fetchMock);

		await client().getHistory({ entityIds: ["sensor.a", "sensor.b"], minimalResponse: true });

		const [url] = fetchMock.mock.calls[0]!;
		expect(String(url)).toContain("/api/history/period?");
		expect(String(url)).toContain("filter_entity_id=sensor.a%2Csensor.b");
		expect(String(url)).toContain("minimal_response=true");
	});

	it("wraps the HaApiError export", () => {
		expect(new HaApiError("x", 500, "b").status).toBe(500);
	});
});

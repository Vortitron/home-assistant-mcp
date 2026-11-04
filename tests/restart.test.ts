import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createBrokeredHaRestClient } from "../src/ha/brokeredClient.js";
import { HaApiError, HaFailoverError, HaRestartingError, createHaRestClient } from "../src/ha/restClient.js";
import { createHaWsClient } from "../src/ha/wsClient.js";
import { explainRestart, looksLikeRestart } from "../src/ha/restart.js";
import { waitUntilRunning } from "../src/tools/system.js";
import { toErrorMessage } from "../src/tools/helpers.js";

/**
 * While Home Assistant restarts every route fails its own way — nginx's HTML
 * 404 on a hosted VM, the portal's 502, "no relay connection", "WebSocket
 * upgrade failed: 404", a refused connection — and agents read those as
 * errors in what they had asked. Reported from a week of real use (Oct 2026).
 */

const logger = createLogger("error");

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The portal's relay of a hosted VM's nginx page while HA is down. */
const NGINX_404 = {
	error: "Non-JSON response from Home Assistant.",
	body: "<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>"
};

afterEach(() => vi.unstubAllGlobals());

describe("looksLikeRestart", () => {
	const api = (status: number, body: unknown) =>
		new HaApiError(`VomeHome broker GET /states responded ${status}`, status, JSON.stringify(body));

	it("recognises each route's way of failing during a restart", () => {
		expect(looksLikeRestart(api(404, NGINX_404))).toBe(true);
		expect(looksLikeRestart(api(502, { error: "Home Assistant is offline (no relay connection)." }))).toBe(true);
		expect(looksLikeRestart(api(502, { error: "WebSocket upgrade failed: HTTP/1.1 404 Not Found" }))).toBe(true);
		expect(looksLikeRestart(api(500, { error: "WebSocket upgrade failed: HTTP/1.1 404 Not Found" }))).toBe(true);
		expect(looksLikeRestart(api(503, {}))).toBe(true);
		const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
		expect(looksLikeRestart(refused, { network: true })).toBe(true);
	});

	it("leaves real answers and Vome's own plumbing alone", () => {
		expect(looksLikeRestart(api(404, { message: "Entity not found." }))).toBe(false);
		expect(looksLikeRestart(api(400, { message: "Failed: connection refused by the device" }))).toBe(false);
		expect(looksLikeRestart(api(502, { error: "Could not reach the relay backend: timeout" }))).toBe(false);
		expect(looksLikeRestart(api(401, { message: "Unauthorized" }))).toBe(false);
		// A refused connection to Vome is not the home restarting.
		const refused = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
		expect(looksLikeRestart(refused)).toBe(false);
	});
});

describe("explainRestart", () => {
	const failure = new HaApiError("VomeHome broker GET /states responded 502: Home Assistant is offline (no relay connection).", 502, "");

	it("reports a restart Home Assistant confirms, with the original error kept briefly", async () => {
		const explained = await explainRestart(failure, async () => ({ state: "NOT_RUNNING" }));
		expect(explained).toBeInstanceOf(HaRestartingError);
		const message = (explained as HaRestartingError).message;
		expect(message).toMatch(/^Home Assistant is restarting \(core state: NOT_RUNNING\)\. Retry in about 60 seconds/);
		expect(message).toContain("no relay connection");
		expect((explained as HaRestartingError).coreState).toBe("NOT_RUNNING");
	});

	it("keeps the original error when Home Assistant answers RUNNING", async () => {
		expect(await explainRestart(failure, async () => ({ state: "RUNNING" }))).toBe(failure);
	});

	it("says 'not answering — it may be restarting' when the check fails the same way", async () => {
		const explained = await explainRestart(failure, async () => {
			throw failure;
		});
		expect((explained as Error).message).toMatch(/^Home Assistant is not answering — it may be restarting; retry in about a minute/);
		expect((explained as HaRestartingError).coreState).toBeNull();
	});

	it("keeps the original error when the check fails for another reason", async () => {
		const explained = await explainRestart(failure, async () => {
			throw new HaApiError("responded 401", 401, "");
		});
		expect(explained).toBe(failure);
	});

	it("passes on a CHAP failover the check found (a config-files call on a stopped main)", async () => {
		const failover = new HaFailoverError("CHAP failover is active: the standby 'House' (rly-s) is running this home", "rly-s", "House", "x");
		const explained = await explainRestart(failure, async () => {
			throw failover;
		});
		expect(explained).toBe(failover);
	});

	it("is shown as written, not with a misleading status appended", async () => {
		const explained = await explainRestart(failure, null);
		expect(toErrorMessage(explained)).toBe((explained as Error).message);
		expect(toErrorMessage(explained)).not.toMatch(/status 503/);
	});
});

describe("the brokered client during a restart", () => {
	const config = loadConfig({ VOMEHOME_API_URL: "https://vome.io", VOMEHOME_TOKEN: "vh", VOMEHOME_INSTANCE_ID: "srv-1" });

	it("turns nginx's 404 page into 'restarting' after one check of /config", async () => {
		const fetchMock = vi.fn(async (input: unknown) =>
			String(input).endsWith("/ha/config") ? jsonResponse({ state: "STARTING", version: "2026.11.0" }) : jsonResponse(NGINX_404, 404)
		);
		vi.stubGlobal("fetch", fetchMock);

		const error = await createBrokeredHaRestClient(config, logger).getStates().catch((e: unknown) => e);

		expect(error).toBeInstanceOf(HaRestartingError);
		expect((error as Error).message).toMatch(/core state: STARTING/);
		expect((error as Error).message).toContain("404 Not Found");
		expect((error as Error).message).not.toContain("<html>");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not check anything for an ordinary 404", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ error: "Entity not found." }, 404));
		vi.stubGlobal("fetch", fetchMock);

		const error = await createBrokeredHaRestClient(config, logger).getState("light.nope").catch((e: unknown) => e);

		expect(error).toBeInstanceOf(HaApiError);
		expect(error).not.toBeInstanceOf(HaRestartingError);
		expect((error as HaApiError).status).toBe(404);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not probe /config to explain a failure of /config itself", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ error: "Home Assistant is offline (no relay connection)." }, 502));
		vi.stubGlobal("fetch", fetchMock);

		const error = await createBrokeredHaRestClient(config, logger).getConfig().catch((e: unknown) => e);

		expect((error as Error).message).toMatch(/not answering — it may be restarting/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("explains a WebSocket command that failed to upgrade", async () => {
		const fetchMock = vi.fn(async (input: unknown) =>
			String(input).endsWith("/ha/config")
				? jsonResponse({ state: "NOT_RUNNING" })
				: jsonResponse({ error: "WebSocket upgrade failed: HTTP/1.1 404 Not Found" }, 502)
		);
		vi.stubGlobal("fetch", fetchMock);

		const error = await createBrokeredHaRestClient(config, logger)
			.sendWsCommand({ type: "config/entity_registry/list" })
			.catch((e: unknown) => e);

		expect((error as Error).message).toMatch(/^Home Assistant is restarting \(core state: NOT_RUNNING\)/);
	});
});

describe("the direct client during a restart", () => {
	const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "tok" });
	const refused = () =>
		new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.2:8123"), { code: "ECONNREFUSED" }) });

	it("says Home Assistant is not answering when its port is closed", async () => {
		const fetchMock = vi.fn(async () => {
			throw refused();
		});
		vi.stubGlobal("fetch", fetchMock);

		const error = await createHaRestClient(config, logger).getStates().catch((e: unknown) => e);

		expect(error).toBeInstanceOf(HaRestartingError);
		expect((error as Error).message).toMatch(/not answering — it may be restarting/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("reports the core state when a proxy 502s but Home Assistant answers the check", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) =>
				String(input).endsWith("/api/config")
					? jsonResponse({ state: "NOT_RUNNING" })
					: new Response("<html>502 Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" })
			)
		);

		const error = await createHaRestClient(config, logger)
			.callService("light", "turn_on", {})
			.catch((e: unknown) => e);

		expect((error as Error).message).toMatch(/^Home Assistant is restarting \(core state: NOT_RUNNING\)/);
	});
});

describe("the direct WebSocket client during a restart", () => {
	it("explains a refused connection instead of a bare ECONNREFUSED", async () => {
		// A port that was just free: nothing listens there now.
		const port = await new Promise<number>((resolve) => {
			const probe = createServer().listen(0, "127.0.0.1", () => {
				const { port } = probe.address() as { port: number };
				probe.close(() => resolve(port));
			});
		});
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
		}));
		const ws = createHaWsClient(loadConfig({ HA_URL: `http://127.0.0.1:${port}`, HA_TOKEN: "tok" }), logger);

		const error = await ws.listEntities().catch((e: unknown) => e);

		expect(error).toBeInstanceOf(HaRestartingError);
		expect((error as Error).message).toMatch(/not answering — it may be restarting/);
		expect((error as Error).message).toContain("ECONNREFUSED");
		await ws.close();
	});
});

describe("waitUntilRunning", () => {
	function fakeClock() {
		let now = 0;
		return { now: () => now, sleep: async (ms: number) => void (now += ms) };
	}

	it("rides out failures and NOT_RUNNING until RUNNING", async () => {
		const getConfig = vi
			.fn()
			.mockRejectedValueOnce(new HaApiError("responded 502", 502, ""))
			.mockResolvedValueOnce({ state: "NOT_RUNNING" })
			.mockResolvedValueOnce({ state: "RUNNING", version: "2026.11.0" });

		const outcome = await waitUntilRunning(getConfig, 90_000, fakeClock());

		expect(outcome).toEqual({ running: true, waited_seconds: 10, checks: 3, state: "RUNNING", version: "2026.11.0" });
	});

	it("gives up at the timeout and says what it last saw", async () => {
		const getConfig = vi.fn(async () => ({ state: "STARTING" }));

		const outcome = await waitUntilRunning(getConfig, 12_000, fakeClock());

		expect(outcome.running).toBe(false);
		expect(outcome.state).toBe("STARTING");
		expect(outcome.waited_seconds).toBe(12);
		expect(getConfig).toHaveBeenCalledTimes(4);
	});
});

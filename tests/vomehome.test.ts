import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import {
	createVomeHomeClient,
	normaliseInstance,
	VomeHomeError,
	type VomeHomeClient
} from "../src/vomehome/client.js";
import type { HaRestClient } from "../src/ha/restClient.js";
import type { HaWsClient } from "../src/ha/wsClient.js";
import { createUnavailableEsphomeClient } from "../src/esphome/client.js";
import { createNodeRedClient } from "../src/nodered/client.js";
import { createInstanceManager } from "../src/vomehome/instances.js";
import { registerVomeHomeTools } from "../src/tools/vomehome.js";
import type { ToolContext } from "../src/tools/helpers.js";

const logger = createLogger("error");

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" }
	});
}

function enabledClient(): VomeHomeClient {
	const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "t", VOMEHOME_TOKEN: "pat-123" });
	return createVomeHomeClient(config, logger);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createVomeHomeClient", () => {
	it("is disabled without a token and points the user at VOMEHOME_TOKEN", async () => {
		const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "t" });
		const client = createVomeHomeClient(config, logger);
		expect(client.isEnabled()).toBe(false);
		await expect(client.listInstances()).rejects.toMatchObject({
			name: "VomeHomeError"
		});
		await expect(client.listInstances()).rejects.toThrow(/VOMEHOME_TOKEN/);
	});

	it("lists instances with the bearer token and normalises snake_case", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				instances: [
					{
						id: "abc",
						name: "Test",
						status: "running",
						ha_url: "https://abc.home.vome.io",
						live: { reachable: true, ha_state: "running" }
					}
				]
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		const instances = await enabledClient().listInstances();

		expect(instances).toHaveLength(1);
		expect(instances[0]).toMatchObject({
			id: "abc",
			haUrl: "https://abc.home.vome.io",
			live: { reachable: true, haState: "running" }
		});
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances");
		expect((init as RequestInit).method).toBe("GET");
		expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer pat-123" });
	});

	it("POSTs a reboot to the instance restart endpoint", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ success: true, message: "Server restarting…" }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await enabledClient().restartInstance("abc");

		expect(result.success).toBe(true);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/abc/restart");
		expect((init as RequestInit).method).toBe("POST");
	});

	it("POSTs name + timezone when creating an instance", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ instance: { id: "new", name: "Sandbox", status: "creating" } }));
		vi.stubGlobal("fetch", fetchMock);

		const instance = await enabledClient().createInstance({ name: "Sandbox", timezone: "Europe/London" });

		expect(instance).toMatchObject({ id: "new", status: "creating" });
		expect(instance.grantedScopes).toBeUndefined();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			name: "Sandbox",
			timezone: "Europe/London"
		});
	});

	it("surfaces granted_scopes from the create response", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				instance: {
					id: "new",
					name: "Sandbox",
					status: "creating",
					granted_scopes: ["ha:read", "ha:write", "ha:config", "ha:files"]
				}
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		const instance = await enabledClient().createInstance({ name: "Sandbox" });
		expect(instance.grantedScopes).toEqual(["ha:read", "ha:write", "ha:config", "ha:files"]);
	});

	it("returns the one-click login url and expiry", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ url: "https://abc.home.vome.io/local/vome_login.html#rt=tok", expires_at: "2026-01-01T00:00:00Z" })
		);
		vi.stubGlobal("fetch", fetchMock);

		const login = await enabledClient().getLoginUrl("abc");

		expect(login.url).toContain("vome_login.html");
		expect(login.expiresAt).toBe("2026-01-01T00:00:00Z");
		expect(fetchMock.mock.calls[0]![0]).toBe("https://vome.io/api/v1/instances/abc/login-url");
	});

	it("throws VomeHomeError carrying status and body on non-2xx", async () => {
		const fetchMock = vi.fn(async () => new Response("forbidden", { status: 403 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(enabledClient().listInstances()).rejects.toMatchObject({
			name: "VomeHomeError",
			status: 403,
			body: "forbidden"
		});
	});

	it("creates a guest link, sending only the fields given", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ id: "lnk-1", url: "https://abc.home.vome.io/local/vome_login.html#rt=x", expires_at: 1_700_100_000 })
		);
		vi.stubGlobal("fetch", fetchMock);

		const link = await enabledClient().createGuestLink("abc", { dashboard: "lovelace-guest" });

		expect(link).toEqual({
			id: "lnk-1",
			url: "https://abc.home.vome.io/local/vome_login.html#rt=x",
			expiresAt: 1_700_100_000
		});
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/abc/guest-links");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({ dashboard: "lovelace-guest" });
	});

	it("throws when the guest-link create response has no id/url", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({}));
		vi.stubGlobal("fetch", fetchMock);

		await expect(enabledClient().createGuestLink("abc", {})).rejects.toMatchObject({
			name: "VomeHomeError"
		});
	});

	it("lists guest links as metadata, tolerating a missing revoked_at", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				guest_links: [
					{ id: "lnk-1", admin: false, dashboard: "d1", created_at: 1, expires_at: 2, revoked_at: null },
					{ id: "lnk-2", admin: true, created_at: 3, expires_at: 4, revoked_at: 5 }
				]
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		const links = await enabledClient().listGuestLinks("abc");
		expect(links).toEqual([
			{ id: "lnk-1", admin: false, dashboard: "d1", createdAt: 1, expiresAt: 2, revokedAt: undefined },
			{ id: "lnk-2", admin: true, dashboard: undefined, createdAt: 3, expiresAt: 4, revokedAt: 5 }
		]);
	});

	it("revokes a guest link with a DELETE to the right path", async () => {
		const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await enabledClient().revokeGuestLink("abc", "lnk-1");
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://vome.io/api/v1/instances/abc/guest-links/lnk-1");
		expect((init as RequestInit).method).toBe("DELETE");
	});
});

describe("normaliseInstance", () => {
	it("rejects objects without an id", () => {
		expect(() => normaliseInstance({ name: "x" })).toThrow(VomeHomeError);
	});

	it("accepts camelCase live fields too", () => {
		const instance = normaliseInstance({ id: "x", haUrl: "https://x", live: { haHealth: "ok" } });
		expect(instance.haUrl).toBe("https://x");
		expect(instance.live?.haHealth).toBe("ok");
	});
});

// --- Tool-layer tests -------------------------------------------------------

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

function buildHarness(
	options: { env?: Record<string, string>; vomehome?: Partial<VomeHomeClient> } = {}
): FakeServer {
	const config = loadConfig({
		HA_URL: "http://ha.local:8123",
		HA_TOKEN: "tok",
		VOMEHOME_TOKEN: "pat",
		...options.env
	});
	const instances = createInstanceManager(config, logger, {} as unknown as HaRestClient);
	const ctx: ToolContext = {
		config,
		logger,
		rest: instances.rest,
		ws: {} as unknown as HaWsClient,
		esphome: createUnavailableEsphomeClient(),
		nodered: createNodeRedClient(config, logger),
		vomehome: (options.vomehome ?? createVomeHomeClient(config, logger)) as VomeHomeClient,
		instances
	};
	const server = new FakeServer();
	registerVomeHomeTools(server as unknown as McpServer, ctx);
	return server;
}

describe("vomehome tools when not configured", () => {
	it("returns a helpful error pointing at VOMEHOME_TOKEN", async () => {
		const server = buildHarness({ env: { VOMEHOME_TOKEN: "" } });
		const result = await server.call("vomehome_list_instances");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/VOMEHOME_TOKEN/);
	});
});

describe("vomehome_reboot_instance safety", () => {
	it("refuses when writes are disabled", async () => {
		const restartInstance = vi.fn();
		const server = buildHarness({ vomehome: { restartInstance } });
		const result = await server.call("vomehome_reboot_instance", { instance_id: "abc" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/HA_ALLOW_WRITE/);
		expect(restartInstance).not.toHaveBeenCalled();
	});

	it("reboots when writes are enabled", async () => {
		const restartInstance = vi.fn(async () => ({ success: true, message: "ok" }));
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, vomehome: { restartInstance } });
		const result = await server.call("vomehome_reboot_instance", { instance_id: "abc" });
		expect(result.isError).toBeUndefined();
		expect(restartInstance).toHaveBeenCalledWith("abc");
		expect(JSON.parse(textOf(result)).rebooting).toBe(true);
	});

	it("uses per-instance write access in brokered mode", async () => {
		const restartInstance = vi.fn(async () => ({ success: true, message: "ok" }));
		const server = buildHarness({
			env: {
				HA_URL: "",
				HA_TOKEN: "",
				VOMEHOME_INSTANCES: '[{"id":"writable-1","write":true},{"id":"readonly-1","write":false}]'
			},
			vomehome: { restartInstance }
		});

		const refused = await server.call("vomehome_reboot_instance", { instance_id: "readonly-1" });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toMatch(/write:false|blocked locally/);
		expect(restartInstance).not.toHaveBeenCalled();

		const allowed = await server.call("vomehome_reboot_instance", { instance_id: "writable-1" });
		expect(allowed.isError).toBeUndefined();
		expect(restartInstance).toHaveBeenCalledWith("writable-1");
	});
});

describe("vomehome_create_instance safety", () => {
	it("refuses in direct mode when VOMEHOME_ALLOW_CREATE is unset", async () => {
		const createInstance = vi.fn();
		const server = buildHarness({ vomehome: { createInstance } });
		const result = await server.call("vomehome_create_instance", { name: "Sandbox" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/VOMEHOME_ALLOW_CREATE/);
		expect(createInstance).not.toHaveBeenCalled();
	});

	it("refuses when VOMEHOME_ALLOW_CREATE is explicitly false", async () => {
		const createInstance = vi.fn();
		const server = buildHarness({
			env: {
				HA_TOKEN: "",
				VOMEHOME_API_URL: "https://vome.io",
				VOMEHOME_TOKEN: "pat",
				VOMEHOME_INSTANCE_ID: "rly-1",
				VOMEHOME_ALLOW_CREATE: "false"
			},
			vomehome: { createInstance }
		});
		const result = await server.call("vomehome_create_instance", { name: "Sandbox" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/VOMEHOME_ALLOW_CREATE=false/);
		expect(createInstance).not.toHaveBeenCalled();
	});

	it("creates in brokered mode without local create/write env flags (API key decides)", async () => {
		const createInstance = vi.fn(async () => ({ id: "new", name: "Sandbox", status: "creating" }));
		const server = buildHarness({
			env: {
				HA_TOKEN: "",
				VOMEHOME_API_URL: "https://vome.io",
				VOMEHOME_TOKEN: "pat",
				VOMEHOME_INSTANCE_ID: "rly-1"
			},
			vomehome: { createInstance }
		});
		const result = await server.call("vomehome_create_instance", { name: "Sandbox" });
		expect(result.isError).toBeUndefined();
		expect(createInstance).toHaveBeenCalledWith({ name: "Sandbox", timezone: undefined });
		expect(JSON.parse(textOf(result)).created).toBe(true);
	});

	it("creates in direct mode when VOMEHOME_ALLOW_CREATE is on", async () => {
		const createInstance = vi.fn(async () => ({ id: "new", name: "Sandbox", status: "creating" }));
		const server = buildHarness({
			env: { VOMEHOME_ALLOW_CREATE: "true" },
			vomehome: { createInstance }
		});
		const result = await server.call("vomehome_create_instance", { name: "Sandbox" });
		expect(result.isError).toBeUndefined();
		expect(createInstance).toHaveBeenCalledWith({ name: "Sandbox", timezone: undefined });
		expect(JSON.parse(textOf(result)).created).toBe(true);
	});
});

describe("vomehome_get_login_url", () => {
	it("returns the login url for the agent to present", async () => {
		const getLoginUrl = vi.fn(async () => ({ url: "https://abc.home.vome.io/local/vome_login.html#rt=tok" }));
		const server = buildHarness({ vomehome: { getLoginUrl } });
		const result = await server.call("vomehome_get_login_url", { instance_id: "abc" });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(textOf(result)).login_url).toContain("vome_login.html");
	});
});

describe("vomehome_create_guest_link safety", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("refuses when config-write is disabled, even if plain write is on", async () => {
		const createGuestLink = vi.fn();
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, vomehome: { createGuestLink } });
		const result = await server.call("vomehome_create_guest_link", { instance_id: "abc" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/HA_ALLOW_CONFIG_WRITE/);
		expect(createGuestLink).not.toHaveBeenCalled();
	});

	it("creates a guest link and passes admin/dashboard/expires_in through", async () => {
		const createGuestLink = vi.fn(async () => ({
			id: "lnk-1",
			url: "https://abc.home.vome.io/local/vome_login.html#rt=x",
			expiresAt: 1_700_100_000
		}));
		const server = buildHarness({ env: WRITE, vomehome: { createGuestLink } });
		const result = await server.call("vomehome_create_guest_link", {
			instance_id: "abc",
			admin: false,
			dashboard: "lovelace-guest",
			expires_in: 3600
		});
		expect(result.isError).toBeUndefined();
		expect(createGuestLink).toHaveBeenCalledWith("abc", {
			admin: false,
			dashboard: "lovelace-guest",
			expiresIn: 3600
		});
		const body = JSON.parse(textOf(result));
		expect(body.id).toBe("lnk-1");
		expect(body.url).toContain("vome_login.html");
		expect(body.note).toMatch(/non-admin/);
	});

	it("notes admin access in the response when admin=true", async () => {
		const createGuestLink = vi.fn(async () => ({ id: "lnk-1", url: "https://x/y" }));
		const server = buildHarness({ env: WRITE, vomehome: { createGuestLink } });
		const result = await server.call("vomehome_create_guest_link", { instance_id: "abc", admin: true });
		expect(JSON.parse(textOf(result)).note).toMatch(/full-admin/);
	});

	it("uses per-instance write access in brokered mode, same as reboot", async () => {
		const createGuestLink = vi.fn(async () => ({ id: "lnk-1", url: "https://x/y" }));
		const server = buildHarness({
			env: {
				HA_URL: "",
				HA_TOKEN: "",
				VOMEHOME_INSTANCES:
					'[{"id":"writable-1","write":true,"config":true},{"id":"readonly-1","write":false}]'
			},
			vomehome: { createGuestLink }
		});

		const refused = await server.call("vomehome_create_guest_link", { instance_id: "readonly-1" });
		expect(refused.isError).toBe(true);
		expect(createGuestLink).not.toHaveBeenCalled();

		const allowed = await server.call("vomehome_create_guest_link", { instance_id: "writable-1" });
		expect(allowed.isError).toBeUndefined();
		expect(createGuestLink).toHaveBeenCalledWith("writable-1", {
			admin: undefined,
			dashboard: undefined,
			expiresIn: undefined
		});
	});
});

describe("vomehome_list_guest_links", () => {
	it("lists guest links without needing write access", async () => {
		const listGuestLinks = vi.fn(async () => [
			{ id: "lnk-1", admin: false, dashboard: "d1", createdAt: 1, expiresAt: 2, revokedAt: undefined }
		]);
		const server = buildHarness({ vomehome: { listGuestLinks } });
		const result = await server.call("vomehome_list_guest_links", { instance_id: "abc" });
		expect(result.isError).toBeUndefined();
		const body = JSON.parse(textOf(result));
		expect(body.count).toBe(1);
		expect(body.guest_links[0].id).toBe("lnk-1");
		expect(listGuestLinks).toHaveBeenCalledWith("abc");
	});
});

describe("vomehome_revoke_guest_link safety", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("refuses when config-write is disabled", async () => {
		const revokeGuestLink = vi.fn();
		const server = buildHarness({ vomehome: { revokeGuestLink } });
		const result = await server.call("vomehome_revoke_guest_link", { instance_id: "abc", link_id: "lnk-1" });
		expect(result.isError).toBe(true);
		expect(revokeGuestLink).not.toHaveBeenCalled();
	});

	it("revokes when config-write is enabled", async () => {
		const revokeGuestLink = vi.fn(async () => undefined);
		const server = buildHarness({ env: WRITE, vomehome: { revokeGuestLink } });
		const result = await server.call("vomehome_revoke_guest_link", { instance_id: "abc", link_id: "lnk-1" });
		expect(result.isError).toBeUndefined();
		expect(revokeGuestLink).toHaveBeenCalledWith("abc", "lnk-1");
		expect(JSON.parse(textOf(result)).revoked).toBe(true);
	});
});

describe("vomehome onboarding tools", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("reports which wizard steps are outstanding", async () => {
		const getOnboarding = vi.fn(async () => ({
			onboarded: false,
			steps: [
				{ step: "user", done: true },
				{ step: "core_config", done: false },
				{ step: "analytics", done: false }
			]
		}));
		const server = buildHarness({ vomehome: { getOnboarding } });
		const result = await server.call("vomehome_get_onboarding", { instance_id: "abc" });
		const body = JSON.parse(textOf(result));
		expect(body.onboarded).toBe(false);
		expect(body.outstanding).toEqual(["core_config", "analytics"]);
	});

	it("refuses to finish the wizard without config-write", async () => {
		/* Finishing the wizard writes this home's location and analytics
		   choice. Those are the owner's to make, which is exactly why
		   provisioning never makes them. */
		const completeOnboarding = vi.fn();
		const server = buildHarness({
			env: { HA_ALLOW_WRITE: "true" },
			vomehome: { completeOnboarding }
		});
		const result = await server.call("vomehome_complete_onboarding", { instance_id: "abc" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/HA_ALLOW_CONFIG_WRITE/);
		expect(completeOnboarding).not.toHaveBeenCalled();
	});

	it("passes core_config through and reports what it did", async () => {
		const completeOnboarding = vi.fn(async () => ({
			completed: ["core_config", "analytics", "integration"],
			alreadyDone: [],
			coreConfigApplied: true,
			steps: [
				{ step: "user", done: true },
				{ step: "core_config", done: true },
				{ step: "analytics", done: true },
				{ step: "integration", done: true }
			]
		}));
		const server = buildHarness({ env: WRITE, vomehome: { completeOnboarding } });
		const result = await server.call("vomehome_complete_onboarding", {
			instance_id: "abc",
			core_config: { time_zone: "Europe/Stockholm", country: "SE" }
		});
		expect(result.isError).toBeUndefined();
		expect(completeOnboarding).toHaveBeenCalledWith("abc", {
			time_zone: "Europe/Stockholm",
			country: "SE"
		});
		const body = JSON.parse(textOf(result));
		expect(body.onboarded).toBe(true);
		expect(body.core_config_applied).toBe(true);
	});

	it("omitting core_config leaves the detected location alone", async () => {
		/* A confidently wrong location is worse than an approximate one. */
		const completeOnboarding = vi.fn(async () => ({
			completed: ["core_config"],
			alreadyDone: [],
			coreConfigApplied: false,
			steps: [{ step: "core_config", done: true }]
		}));
		const server = buildHarness({ env: WRITE, vomehome: { completeOnboarding } });
		await server.call("vomehome_complete_onboarding", { instance_id: "abc" });
		expect(completeOnboarding).toHaveBeenCalledWith("abc", undefined);
	});
});

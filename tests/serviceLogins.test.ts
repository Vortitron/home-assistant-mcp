import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import type { HaRestClient } from "../src/ha/restClient.js";
import type { HaWsClient } from "../src/ha/wsClient.js";
import { createUnavailableEsphomeClient, type EsphomeClient } from "../src/esphome/client.js";
import { createNodeRedClient } from "../src/nodered/client.js";
import { createVomeHomeClient } from "../src/vomehome/client.js";
import { createInstanceManager } from "../src/vomehome/instances.js";
import type { ToolContext } from "../src/tools/helpers.js";
import {
	SERVICE_LOGIN_MARKER,
	generateServicePassword,
	registerServiceLoginTools,
	setOption,
	upsertSecret
} from "../src/tools/serviceLogins.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

const logger = createLogger("error");
const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };
const BROKERED = { HA_TOKEN: "", VOMEHOME_TOKEN: "vh_test", VOMEHOME_INSTANCE_ID: "rly-1", ...WRITE };
const ADDON = {
	kind: "addon_options",
	slug: "45df7312_zigbee2mqtt",
	username_option: "mqtt.user",
	password_option: "mqtt.password"
};

function harness(env: Record<string, string>, sendCommand: (c: any) => Promise<unknown>) {
	const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "tok", ...env });
	const rest = {} as unknown as HaRestClient;
	const ctx: ToolContext = {
		config,
		logger,
		rest,
		ws: { sendCommand } as unknown as HaWsClient,
		esphome: createUnavailableEsphomeClient() as EsphomeClient,
		nodered: createNodeRedClient(config, logger),
		vomehome: createVomeHomeClient(config, logger),
		instances: createInstanceManager(config, logger, rest)
	};
	const tools = new Map<string, Handler>();
	registerServiceLoginTools(
		{ registerTool: (name: string, _c: unknown, h: Handler) => tools.set(name, h) } as unknown as McpServer,
		ctx
	);
	return (args: Record<string, unknown>) => tools.get("ha_provision_service_login")!(args, {});
}

const text = (r: CallToolResult) => r.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");

/** A fake home: records every command and remembers the password it was given. */
function fakeHome(opts: { users?: any[]; addonOptions?: any; failOptionsPost?: (pw: string) => Error } = {}) {
	const calls: any[] = [];
	let password = "";
	const sendCommand = vi.fn(async (c: any) => {
		calls.push(c);
		if (c.type === "config/auth/list") return opts.users ?? [];
		if (c.type === "config/auth/create") return { user: { id: "u-new", name: c.name } };
		if (c.type.startsWith("config/auth_provider/homeassistant/")) {
			password = c.password ?? password;
			return {};
		}
		if (c.type === "config/auth/delete") return {};
		if (c.type === "supervisor/api") {
			if (c.endpoint.endsWith("/info")) {
				if (opts.addonOptions === undefined) throw new Error("addon not found");
				return { data: { options: structuredClone(opts.addonOptions) } };
			}
			if (c.endpoint.endsWith("/options") && opts.failOptionsPost) {
				throw opts.failOptionsPost(c.data.options.mqtt.password);
			}
			return {};
		}
		throw new Error(`unexpected ${c.type}`);
	});
	return { sendCommand, calls, password: () => password };
}

afterEach(() => vi.unstubAllGlobals());

describe("secret and option helpers", () => {
	it("replaces a top-level key, keeps the rest, and ignores indented lookalikes", () => {
		const before = 'wifi_ssid: "home"\nmqtt_password: "old"\nnested:\n  mqtt_password: keep\n';
		const after = upsertSecret(before, "mqtt_password", "abc");
		expect(after).toBe('wifi_ssid: "home"\nmqtt_password: "abc"\nnested:\n  mqtt_password: keep\n');
	});

	it("appends to a file without the key, and starts a missing file", () => {
		expect(upsertSecret('a: "1"', "b", "2")).toBe('a: "1"\nb: "2"\n');
		expect(upsertSecret(null, "b", "2")).toBe('b: "2"\n');
	});

	it("sets a dotted option path, creating maps on the way", () => {
		const options: Record<string, unknown> = { mqtt: { server: "mqtt://core-mosquitto" } };
		setOption(options, "mqtt.user", "z2m");
		setOption(options, "serial.port", "/dev/ttyUSB0");
		expect(options).toEqual({
			mqtt: { server: "mqtt://core-mosquitto", user: "z2m" },
			serial: { port: "/dev/ttyUSB0" }
		});
	});

	it("generates 128-bit hex passwords that differ", () => {
		const a = generateServicePassword();
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(generateServicePassword()).not.toBe(a);
	});
});

describe("ha_provision_service_login", () => {
	it("refuses without config-write before touching the home", async () => {
		const home = fakeHome({ addonOptions: {} });
		const r = await harness({}, home.sendCommand)({ instance_id: "x", name: "Z2M", username: "z2m", deliver_to: [ADDON] });
		expect(r.isError).toBe(true);
		expect(home.sendCommand).not.toHaveBeenCalled();
	});

	it("refuses when the named home is not the one this session targets", async () => {
		const home = fakeHome({ addonOptions: {} });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const r = await harness(BROKERED, home.sendCommand)({
			instance_id: "the-demo-vm", name: "Z2M", username: "z2m", deliver_to: [ADDON]
		});
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("rly-1");
		expect(home.sendCommand).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("creates a local-only read-only login, delivers it, and never returns the password", async () => {
		const home = fakeHome({ addonOptions: { mqtt: { server: "mqtt://core-mosquitto:1883" } } });
		const r = await harness(WRITE, home.sendCommand)({
			instance_id: "direct", name: "Zigbee2MQTT", username: "z2m", deliver_to: [{ ...ADDON, restart: true }]
		});
		expect(r.isError).toBeFalsy();
		const create = home.calls.find((c) => c.type === "config/auth/create");
		expect(create).toMatchObject({
			name: `Zigbee2MQTT ${SERVICE_LOGIN_MARKER}`,
			group_ids: ["system-read-only"],
			local_only: true
		});
		const post = home.calls.find((c) => c.endpoint?.endsWith("/options"));
		expect(post.data.options).toEqual({
			mqtt: { server: "mqtt://core-mosquitto:1883", user: "z2m", password: home.password() }
		});
		expect(home.calls.some((c) => c.endpoint?.endsWith("/restart"))).toBe(true);
		expect(home.password()).toMatch(/^[0-9a-f]{32}$/);
		expect(text(r)).not.toContain(home.password());
		const first = r.content[0];
		expect(JSON.parse(first.type === "text" ? first.text : "")).toMatchObject({
			created: true,
			password_returned: false
		});
	});

	it("never offers an admin role", async () => {
		const home = fakeHome({ addonOptions: {} });
		await harness(WRITE, home.sendCommand)({
			instance_id: "direct", name: "Energy", username: "ftw", role: "user", deliver_to: [ADDON]
		});
		expect(home.calls.find((c) => c.type === "config/auth/create").group_ids).toEqual(["system-users"]);
	});

	it("creates nothing when a target cannot be reached", async () => {
		const home = fakeHome({ addonOptions: undefined });
		const r = await harness(WRITE, home.sendCommand)({
			instance_id: "direct", name: "Z2M", username: "z2m", deliver_to: [ADDON]
		});
		expect(r.isError).toBe(true);
		expect(home.calls.some((c) => c.type.startsWith("config/auth"))).toBe(false);
	});

	it("deletes a fresh login that could be delivered nowhere, and scrubs the password from the error", async () => {
		const home = fakeHome({
			addonOptions: {},
			// Supervisor's schema errors can quote the rejected value.
			failOptionsPost: (pw) => new Error(`invalid value '${pw}' for option password`)
		});
		const r = await harness(WRITE, home.sendCommand)({
			instance_id: "direct", name: "Z2M", username: "z2m", deliver_to: [ADDON]
		});
		expect(r.isError).toBe(true);
		expect(home.calls.some((c) => c.type === "config/auth/delete" && c.user_id === "u-new")).toBe(true);
		expect(text(r)).toContain("rolled_back");
		expect(text(r)).not.toContain(home.password());
		expect(text(r)).toContain("[redacted]");
	});

	it("will not take a username another account already uses", async () => {
		const home = fakeHome({
			addonOptions: {},
			users: [{ id: "u1", username: "andy", name: "Andy", is_owner: true, system_generated: false, group_ids: ["system-admin"] }]
		});
		const r = await harness(WRITE, home.sendCommand)({
			instance_id: "direct", name: "Z2M", username: "andy", deliver_to: [ADDON]
		});
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("did not create");
	});

	it("rotates only logins it made itself — never the owner's, even when asked", async () => {
		const owner = { id: "u1", username: "andy", name: `Andy ${SERVICE_LOGIN_MARKER}`, is_owner: true, system_generated: false, group_ids: ["system-admin"] };
		const ownerHome = fakeHome({ addonOptions: {}, users: [owner] });
		const refused = await harness(WRITE, ownerHome.sendCommand)({
			instance_id: "direct", name: "x", username: "andy", rotate: true, deliver_to: [ADDON]
		});
		expect(refused.isError).toBe(true);
		expect(ownerHome.calls.some((c) => c.type.includes("change_password"))).toBe(false);

		const svc = { id: "u9", username: "z2m", name: `Z2M ${SERVICE_LOGIN_MARKER}`, is_owner: false, system_generated: false, group_ids: ["system-read-only"] };
		const svcHome = fakeHome({ addonOptions: {}, users: [svc] });
		const ok = await harness(WRITE, svcHome.sendCommand)({
			instance_id: "direct", name: "Z2M", username: "z2m", rotate: true, deliver_to: [ADDON]
		});
		expect(ok.isError).toBeFalsy();
		expect(svcHome.calls.find((c) => c.type.includes("admin_change_password")).user_id).toBe("u9");
		expect(svcHome.calls.some((c) => c.type === "config/auth/create")).toBe(false);
		expect(text(ok)).not.toContain(svcHome.password());
	});

	it("refuses a secrets file without a relay, before creating anything", async () => {
		const home = fakeHome();
		const r = await harness(WRITE, home.sendCommand)({
			instance_id: "direct", name: "ESPHome", username: "esp",
			deliver_to: [{ kind: "secrets_file", path: "esphome/secrets.yaml", password_key: "mqtt_password" }]
		});
		expect(r.isError).toBe(true);
		expect(home.sendCommand).not.toHaveBeenCalled();
	});

	it("writes a secrets file through the relay, keeping its other keys", async () => {
		const home = fakeHome();
		const writes: any[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: any) => {
			const url = String(input);
			if (url.includes("/files/read")) {
				return new Response(JSON.stringify({ content: 'wifi_ssid: "home"\n' }), { status: 200 });
			}
			writes.push({ url, body: JSON.parse(init.body) });
			return new Response(JSON.stringify({ written: true }), { status: 200 });
		}));
		const r = await harness(BROKERED, home.sendCommand)({
			instance_id: "rly-1", name: "ESPHome", username: "esp",
			deliver_to: [{ kind: "secrets_file", path: "esphome/secrets.yaml", password_key: "mqtt_password", username_key: "mqtt_user" }]
		});
		expect(r.isError).toBeFalsy();
		expect(writes).toHaveLength(1);
		expect(writes[0].url).toContain(encodeURIComponent("esphome/secrets.yaml"));
		expect(writes[0].body.content).toBe(
			`wifi_ssid: "home"\nmqtt_password: "${home.password()}"\nmqtt_user: "esp"\n`
		);
		expect(text(r)).not.toContain(home.password());
	});
});

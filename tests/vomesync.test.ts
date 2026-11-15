import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { HaApiError, type HaRestClient } from "../src/ha/restClient.js";
import type { HaWsClient } from "../src/ha/wsClient.js";
import { createUnavailableEsphomeClient } from "../src/esphome/client.js";
import { createNodeRedClient } from "../src/nodered/client.js";
import { createInstanceManager } from "../src/vomehome/instances.js";
import type { VomeHomeClient, VomeSyncPass } from "../src/vomehome/client.js";
import { registerVomeSyncTools } from "../src/tools/vomesync.js";
import type { ToolContext } from "../src/tools/helpers.js";

/*
 * Owner, 15 Nov 2026: an agent should be able to make VomeSync switches, and a
 * paying Vome customer (a package set by hand counts) skips the CAPTCHA.
 */

const logger = createLogger("error");
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

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

function parsed(result: CallToolResult): Record<string, unknown> {
	const first = result.content[0];
	return JSON.parse(first && first.type === "text" ? first.text : "{}") as Record<string, unknown>;
}

function textOf(result: CallToolResult): string {
	const first = result.content[0];
	return first && first.type === "text" ? first.text : "";
}

function harness(options: {
	env?: Record<string, string>;
	pass?: VomeSyncPass | Error;
	callService?: (...args: unknown[]) => Promise<unknown>;
}) {
	const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "tok", VOMEHOME_TOKEN: "pat", ...options.env });
	const instances = createInstanceManager(config, logger, {} as unknown as HaRestClient);
	const callService = vi.fn(options.callService ?? (async () => ({ changed_states: [], service_response: { uid: "vs_new" } })));
	const vomesyncPass = vi.fn(async () => {
		if (options.pass instanceof Error) throw options.pass;
		return options.pass ?? { pass: "vsp1.1.n.r.s", expires_at: 1, paying: true };
	});
	const ctx: ToolContext = {
		config,
		logger,
		rest: { callService } as unknown as HaRestClient,
		ws: {} as unknown as HaWsClient,
		esphome: createUnavailableEsphomeClient(),
		nodered: createNodeRedClient(config, logger),
		vomehome: { isEnabled: () => config.vomehome.enabled, vomesyncPass } as unknown as VomeHomeClient,
		instances
	};
	const server = new FakeServer();
	registerVomeSyncTools(server as unknown as McpServer, ctx);
	return { server, callService, vomesyncPass };
}

const WRITE = { HA_ALLOW_WRITE: "true" };

describe("vomesync_create_switch", () => {
	it("is refused while writes are off", async () => {
		const { server, callService } = harness({});
		const result = await server.call("vomesync_create_switch", { name: "Lamp" });
		expect(result.isError).toBe(true);
		expect(callService).not.toHaveBeenCalled();
	});

	it("makes a private switch without asking for a pass", async () => {
		const { server, callService, vomesyncPass } = harness({ env: WRITE });
		const result = await server.call("vomesync_create_switch", { name: "Lamp", category: "Personal" });
		expect(parsed(result)).toEqual({ uid: "vs_new", name: "Lamp", public: false });
		expect(vomesyncPass).not.toHaveBeenCalled();
		expect(callService).toHaveBeenCalledWith("vomesync", "create_switch", { name: "Lamp", category: "Personal" }, undefined, {
			returnResponse: true
		});
	});

	it("sends a paying account's pass as the CAPTCHA token for a public switch", async () => {
		const { server, callService } = harness({ env: WRITE });
		const result = await server.call("vomesync_create_switch", { name: "Briefing", publicize: true });
		expect(parsed(result)).toMatchObject({ uid: "vs_new", public: true, used_vome_pass: true });
		expect(callService.mock.calls[0][2]).toEqual({ name: "Briefing", publicize: true, captcha_token: "vsp1.1.n.r.s" });
	});

	it("still tries without a pass, and explains a CAPTCHA refusal", async () => {
		const { server, callService } = harness({
			env: WRITE,
			pass: { paying: false, error: "Skipping the CAPTCHA comes with a Vome plan." },
			callService: async () => {
				throw new HaApiError("Captcha required", 500, "Captcha required");
			}
		});
		const result = await server.call("vomesync_create_switch", { name: "Briefing", publicize: true });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/CAPTCHA/);
		expect(textOf(result)).toMatch(/Vome plan/);
		expect(callService.mock.calls[0][2]).not.toHaveProperty("captcha_token");
	});

	it("goes ahead without a pass when the sync server needs none", async () => {
		const { server } = harness({ env: WRITE, pass: new Error("portal down") });
		const result = await server.call("vomesync_create_switch", { name: "Briefing", publicize: true });
		expect(parsed(result)).toMatchObject({ uid: "vs_new", used_vome_pass: false });
		expect(String(parsed(result).pass_note)).toMatch(/portal down/);
	});
});

describe("vomesync_update_switch", () => {
	it("sends only what changes, with a pass when making it public", async () => {
		const { server, callService } = harness({
			env: WRITE,
			callService: async () => ({ changed_states: [], service_response: { uid: "vs_a", publicize: true } })
		});
		const result = await server.call("vomesync_update_switch", { entity_id: "switch.daily_briefing", publicize: true });
		expect(parsed(result)).toMatchObject({ updated: "switch.daily_briefing", used_vome_pass: true });
		expect(callService).toHaveBeenCalledWith(
			"vomesync",
			"update_switch",
			{ entity_id: "switch.daily_briefing", publicize: true, captcha_token: "vsp1.1.n.r.s" },
			undefined,
			{ returnResponse: true }
		);
	});

	it("needs no pass to go private or rename, and refuses an empty change", async () => {
		const { server, callService, vomesyncPass } = harness({ env: WRITE });
		await server.call("vomesync_update_switch", { entity_id: "switch.a", publicize: false, name: "B" });
		expect(vomesyncPass).not.toHaveBeenCalled();
		expect(callService.mock.calls[0][2]).toEqual({ entity_id: "switch.a", name: "B", publicize: false });
		const empty = await server.call("vomesync_update_switch", { entity_id: "switch.a" });
		expect(empty.isError).toBe(true);
	});

	it("points at an old integration when the action is missing", async () => {
		const { server } = harness({
			env: WRITE,
			callService: async () => {
				throw new HaApiError("Service vomesync.update_switch not found", 400, "");
			}
		});
		const result = await server.call("vomesync_update_switch", { entity_id: "switch.a", name: "B" });
		expect(textOf(result)).toMatch(/0\.9\.68/);
	});
});

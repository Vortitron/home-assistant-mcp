import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createInstanceManager } from "../src/vomehome/instances.js";
import type { HaWsClient } from "../src/ha/wsClient.js";
import { createUnavailableEsphomeClient } from "../src/esphome/client.js";
import { createNodeRedClient } from "../src/nodered/client.js";
import type { VomeHomeClient, VomeHomeInstance } from "../src/vomehome/client.js";
import { withStartingInstanceCheck } from "../src/tools/instanceCheck.js";
import type { InstanceChoice, ToolContext } from "../src/tools/helpers.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

class FakeServer {
	readonly tools = new Map<string, Handler>();
	registerTool(name: string, _config: unknown, handler: Handler): void {
		this.tools.set(name, handler);
	}
	call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
		return (this.tools.get(name) as Handler)(args, {});
	}
}

const logger = createLogger("error");
const texts = (result: CallToolResult): string[] => result.content.map((block) => (block.type === "text" ? block.text : ""));
const notice = (result: CallToolResult): string => texts(result).find((t) => t.startsWith("[vome-notice]")) ?? "";

/** A context on rly-old (or the env's choice), with a list the portal answers from `rows`. */
function harness(
	rows: VomeHomeInstance[] | (() => Promise<VomeHomeInstance[]>),
	choice: InstanceChoice | undefined,
	env: Record<string, string> = {}
) {
	const config = loadConfig({
		VOMEHOME_TOKEN: "vh_test",
		VOMEHOME_API_URL: "https://vome.io",
		VOMEHOME_INSTANCES: JSON.stringify(["rly-old", "rly-new"]),
		...env
	});
	const instances = createInstanceManager(config, logger);
	const listInstances = vi.fn(typeof rows === "function" ? rows : async () => rows);
	const ctx: ToolContext = {
		config,
		logger,
		rest: instances.rest,
		ws: {} as unknown as HaWsClient,
		esphome: createUnavailableEsphomeClient(),
		nodered: createNodeRedClient(config, logger),
		vomehome: { isEnabled: () => true, listInstances } as unknown as VomeHomeClient,
		instances,
		...(choice ? { instanceChoice: choice } : {})
	};
	const fake = new FakeServer();
	const server = withStartingInstanceCheck(fake as unknown as McpServer, ctx);
	let fail = false;
	server.registerTool("ha_get_state", {} as never, (async () =>
		fail
			? { isError: true, content: [{ type: "text", text: "502 Bad Gateway" }] }
			: { content: [{ type: "text", text: "{}" }] }) as never);
	server.registerTool("vomehome_use_instance", {} as never, (async (args: { instance_id: string }) => {
		instances.use(args.instance_id);
		return { content: [{ type: "text", text: "{}" }] };
	}) as never);
	return { fake, ctx, listInstances, failCalls: (value: boolean) => (fail = value) };
}

const OLD_OFFLINE: VomeHomeInstance = { id: "rly-old", name: "GamlaBio (old)", kind: "relay", live: { reachable: false } };
const NEW_ONLINE: VomeHomeInstance = { id: "rly-new", name: "GamlaBio", kind: "relay", live: { reachable: true } };

describe("starting-instance check", () => {
	it("asks the portal once, with its live probe", async () => {
		const { fake, listInstances } = harness([OLD_OFFLINE, NEW_ONLINE], { source: "remembered" });
		await Promise.all([fake.call("ha_get_state"), fake.call("ha_get_state")]);
		await fake.call("ha_get_state");
		expect(listInstances).toHaveBeenCalledTimes(1);
		expect(listInstances).toHaveBeenCalledWith({ live: true });
	});

	it("repeats the warning on errors while still on the offline home, and stops once the caller switches", async () => {
		const { fake, ctx, failCalls } = harness([OLD_OFFLINE, NEW_ONLINE], { source: "remembered" });
		expect(notice(await fake.call("ha_get_state"))).toMatch(/WARNING.*rly-old/);
		expect(notice(await fake.call("ha_get_state"))).toBe("");
		failCalls(true);
		expect(notice(await fake.call("ha_get_state"))).toMatch(/OFFLINE/);

		await fake.call("vomehome_use_instance", { instance_id: "rly-new" });
		expect(ctx.instances.chosenId()).toBe("rly-new");
		expect(notice(await fake.call("ha_get_state"))).toBe("");
	});

	it("keeps VOMEHOME_INSTANCE_ID's instance in stdio, saying it was configured", async () => {
		const { fake, ctx } = harness([OLD_OFFLINE, NEW_ONLINE], { source: "configured" }, { VOMEHOME_INSTANCE_ID: "rly-old" });
		const result = await fake.call("ha_get_state");
		expect(ctx.instances.activeId()).toBe("rly-old");
		expect(notice(result)).toMatch(/VOMEHOME_INSTANCE_ID names it/);
	});

	it("falls back from an offline default only to an instance the session may target", async () => {
		const elsewhere: VomeHomeInstance = { id: "undeclared", live: { reachable: true } };
		const { fake, ctx } = harness([OLD_OFFLINE, elsewhere], { source: "default" });
		const result = await fake.call("ha_get_state");
		expect(ctx.instances.activeId()).toBe("rly-old");
		expect(notice(result)).toMatch(/WARNING/);
		expect(notice(result)).toMatch(/Online now: undeclared/);
	});

	it("falls back from an offline default without counting it as a choice", async () => {
		const { fake, ctx } = harness([OLD_OFFLINE, NEW_ONLINE], { source: "default" });
		const result = await fake.call("ha_get_state");
		expect(ctx.instances.activeId()).toBe("rly-new");
		expect(ctx.instances.chosenId()).toBeNull();
		expect(notice(result)).toMatch(/started on rly-new/);
	});

	it("says nothing when the home is online, its status is unknown, or the portal cannot answer", async () => {
		for (const rows of [
			[{ ...OLD_OFFLINE, live: { reachable: true } }, NEW_ONLINE],
			[{ id: "rly-old" }, NEW_ONLINE],
			async () => {
				throw new Error("portal down");
			}
		] as Array<VomeHomeInstance[] | (() => Promise<VomeHomeInstance[]>)>) {
			const { fake, ctx } = harness(rows, { source: "default" });
			const result = await fake.call("ha_get_state");
			expect(notice(result)).toBe("");
			expect(texts(result)[0]).toBe("{}");
			expect(ctx.instances.activeId()).toBe("rly-old");
		}
	});

	it("does nothing for a context no server set up (no instanceChoice)", async () => {
		const { fake, listInstances } = harness([OLD_OFFLINE, NEW_ONLINE], undefined);
		expect(notice(await fake.call("ha_get_state"))).toBe("");
		expect(listInstances).not.toHaveBeenCalled();
	});
});

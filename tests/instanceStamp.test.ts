import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	STAMP_PREFIX,
	appendStamp,
	createIdentityReader,
	withInstanceStamp
} from "../src/tools/instanceStamp.js";
import type { ToolContext } from "../src/tools/helpers.js";

/**
 * Every reply must say which Home Assistant answered it.
 *
 * Two separate agents came unstuck for want of this. One was handed a routing
 * hint, followed it, and overwrote a live customer's configuration.yaml — the
 * reply it read looked exactly like a correct one. Another stopped work
 * because endpoints disagreed about the target and it had no way to tell
 * which to believe. Both had to infer the target from replies that never
 * mentioned it.
 */

function ctxWith(config: unknown, id = "748d339f"): ToolContext {
	return {
		instances: { activeId: () => id },
		rest: { getConfig: async () => config }
	} as unknown as ToolContext;
}

describe("the stamp names the home, not just the id", () => {
	it("carries the home's own name, version and size", async () => {
		const identity = createIdentityReader(
			ctxWith({ location_name: "Home", version: "2026.9.3", components: new Array(154) })
		);
		const stamped = appendStamp({ content: [{ type: "text", text: "{}" }] }, await identity());
		const text = stamped.content.at(-1)?.text ?? "";
		expect(text).toContain(STAMP_PREFIX);
		expect(text).toContain("target=748d339f");
		expect(text).toContain('home="Home"');
		expect(text).toContain("components=154");
	});

	it("makes the wrong home wrong on sight", async () => {
		/* An id alone only echoes what was asked for. The name and size are
		   what let a reader see that a request for a fresh demo box came back
		   from a 355-component production home. */
		const identity = createIdentityReader(
			ctxWith({ location_name: "GamlaBio", version: "2026.9.3", components: new Array(355) })
		);
		const text = appendStamp({ content: [] }, await identity()).content.at(-1)?.text ?? "";
		expect(text).toContain('home="GamlaBio"');
		expect(text).toContain("components=355");
	});

	it("says so loudly when it cannot verify", async () => {
		const ctx = {
			instances: { activeId: () => "748d339f" },
			rest: {
				getConfig: async () => {
					throw new Error("No response from Home Assistant");
				}
			}
		} as unknown as ToolContext;
		const text = appendStamp({ content: [] }, await createIdentityReader(ctx)()).content.at(-1)?.text ?? "";
		expect(text).toContain("UNVERIFIED");
		expect(text).toContain("Do not assume");
	});

	it("does not disturb a payload a caller parses", async () => {
		const identity = createIdentityReader(ctxWith({ location_name: "Home" }));
		const stamped = appendStamp(
			{ content: [{ type: "text", text: '{"entities":[]}' }] },
			await identity()
		);
		expect(JSON.parse(stamped.content[0].text as string)).toEqual({ entities: [] });
		expect(stamped.content).toHaveLength(2);
	});

	it("preserves isError", async () => {
		const identity = createIdentityReader(ctxWith({ location_name: "Home" }));
		const stamped = appendStamp(
			{ content: [{ type: "text", text: "boom" }], isError: true },
			await identity()
		);
		expect(stamped.isError).toBe(true);
	});
});

describe("every registered tool is stamped", () => {
	it("wraps the handler so a reply cannot omit its origin", async () => {
		const handlers = new Map<string, (...a: unknown[]) => Promise<CallToolResult>>();
		const server = {
			registerTool: (name: string, _cfg: unknown, handler: (...a: unknown[]) => Promise<CallToolResult>) => {
				handlers.set(name, handler);
			}
		} as unknown as McpServer;

		const ctx = ctxWith({ location_name: "Home", components: new Array(154) });
		const wrapped = withInstanceStamp(server, ctx);
		wrapped.registerTool(
			"ha_get_state",
			{},
			async () => ({ content: [{ type: "text", text: '{"state":"on"}' }] })
		);

		const result = await handlers.get("ha_get_state")!({});
		expect(result.content).toHaveLength(2);
		expect(result.content.at(-1)?.text).toContain(STAMP_PREFIX);
	});

	it("a failing stamp never fails the tool", async () => {
		const handlers = new Map<string, (...a: unknown[]) => Promise<CallToolResult>>();
		const server = {
			registerTool: (name: string, _cfg: unknown, handler: (...a: unknown[]) => Promise<CallToolResult>) => {
				handlers.set(name, handler);
			}
		} as unknown as McpServer;

		const ctx = {
			instances: {
				activeId: () => {
					throw new Error("registry exploded");
				}
			},
			rest: { getConfig: async () => ({}) }
		} as unknown as ToolContext;

		const wrapped = withInstanceStamp(server, ctx);
		wrapped.registerTool("ha_get_state", {}, async () => ({
			content: [{ type: "text", text: "payload" }]
		}));

		const result = await handlers.get("ha_get_state")!({});
		expect(result.content[0]?.text).toBe("payload");
	});

	it("reads the identity once per window, not once per call", async () => {
		const getConfig = vi.fn(async () => ({ location_name: "Home" }));
		const ctx = {
			instances: { activeId: () => "748d339f" },
			rest: { getConfig }
		} as unknown as ToolContext;
		const identity = createIdentityReader(ctx);
		await identity();
		await identity();
		await identity();
		expect(getConfig).toHaveBeenCalledTimes(1);
	});

	it("tracks a switch of active instance", async () => {
		let active = "aaa";
		const ctx = {
			instances: { activeId: () => active },
			rest: { getConfig: async () => ({ location_name: active === "aaa" ? "Demo" : "GamlaBio" }) }
		} as unknown as ToolContext;
		const identity = createIdentityReader(ctx);
		expect((await identity()).home).toBe("Demo");
		active = "bbb";
		expect((await identity()).home).toBe("GamlaBio");
	});
});

describe("naming the home on any call", () => {
	/* Reads answered from the wrong house three times: another window of the
	   same client had moved the shared starting choice, and "entity not found"
	   or an empty history looked like real answers. Every tool can now be told
	   which home is meant, and refuses instead of answering from another. */
	function harness(brokered: boolean) {
		const registered = new Map<string, { config: any; handler: (...a: any[]) => Promise<CallToolResult> }>();
		const fake = {
			registerTool: (name: string, config: unknown, handler: any) => registered.set(name, { config, handler })
		} as unknown as McpServer;
		const ctx = {
			config: { brokered },
			instances: { activeId: () => "rly-1" },
			rest: { getConfig: async () => ({ location_name: "Home" }) }
		} as unknown as ToolContext;
		const server = withInstanceStamp(fake, ctx);
		const seen: unknown[] = [];
		const handler = vi.fn(async (args: unknown) => {
			seen.push(args);
			return { content: [{ type: "text" as const, text: "ok" }] };
		});
		return { server, registered, handler, seen };
	}

	it("refuses a read that names another home, without running it", async () => {
		const { server, registered, handler } = harness(true);
		server.registerTool("ha_get_history", { inputSchema: { entity_ids: {} } } as any, handler as any);
		const result = await registered.get("ha_get_history")!.handler({ entity_ids: ["x"], instance_id: "rly-2" }, {});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as any).text).toContain('targeting "rly-1"');
		expect(handler).not.toHaveBeenCalled();
	});

	it("runs when the named home is the target, and the tool never sees the extra argument", async () => {
		const { server, registered, handler, seen } = harness(true);
		server.registerTool("ha_get_history", { inputSchema: { entity_ids: {} } } as any, handler as any);
		const result = await registered.get("ha_get_history")!.handler({ entity_ids: ["x"], instance_id: "rly-1" }, {});
		expect(result.isError).toBeFalsy();
		expect(seen[0]).toEqual({ entity_ids: ["x"] });
	});

	it("leaves direct mode, omitted ids, and tools that own the argument alone", async () => {
		const direct = harness(false);
		direct.server.registerTool("ha_list_entities", { inputSchema: {} } as any, direct.handler as any);
		expect((await direct.registered.get("ha_list_entities")!.handler({ instance_id: "other" }, {})).isError).toBeFalsy();

		const { server, registered, handler } = harness(true);
		server.registerTool("ha_list_entities", { inputSchema: {} } as any, handler as any);
		expect((await registered.get("ha_list_entities")!.handler({}, {})).isError).toBeFalsy();
		expect(registered.get("ha_list_entities")!.config.inputSchema).toHaveProperty("instance_id");

		server.registerTool("vomehome_use_instance", { inputSchema: { instance_id: {} } } as any, handler as any);
		expect(registered.get("vomehome_use_instance")!.config.inputSchema.instance_id).toEqual({});
		server.registerTool("vomehome_list_instances", { inputSchema: {} } as any, handler as any);
		expect(registered.get("vomehome_list_instances")!.config.inputSchema).not.toHaveProperty("instance_id");
	});
});

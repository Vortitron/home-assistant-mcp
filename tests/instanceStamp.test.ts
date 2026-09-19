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

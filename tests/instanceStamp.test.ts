import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	STAMP_PREFIX,
	appendStamp,
	createIdentityReader,
	withInstanceStamp
} from "../src/tools/instanceStamp.js";
import type { ToolContext } from "../src/tools/helpers.js";
import { HaApiError, HaRestartingError, type HaRestClient } from "../src/ha/restClient.js";
import { loadConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import { createInstanceManager } from "../src/vomehome/instances.js";

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

	it("says a restart is a restart, not an unverified identity", async () => {
		// "identity UNVERIFIED — do not assume this reply came from the
		// instance you meant" on every reply while a home restarts taught
		// agents to distrust the stamp, or to ignore it.
		const ctx = {
			instances: { activeId: () => "748d339f" },
			rest: {
				getConfig: async () => {
					throw new HaRestartingError("Home Assistant is not answering — it may be restarting", null, "502");
				}
			}
		} as unknown as ToolContext;
		const text = appendStamp({ content: [] }, await createIdentityReader(ctx)()).content.at(-1)?.text ?? "";
		expect(text).toContain("target=748d339f");
		expect(text).toMatch(/Home Assistant is restarting or not answering; identity not checked/);
		expect(text).not.toContain("UNVERIFIED");
	});

	it("notes a home that answered while still starting", async () => {
		const identity = createIdentityReader(ctxWith({ location_name: "Home", version: "2026.11.0", state: "STARTING" }));
		const text = appendStamp({ content: [] }, await identity()).content.at(-1)?.text ?? "";
		expect(text).toContain('home="Home"');
		expect(text).toContain("core=STARTING");
		const running = createIdentityReader(ctxWith({ location_name: "Home", state: "RUNNING" }));
		expect(appendStamp({ content: [] }, await running()).content.at(-1)?.text).not.toContain("core=");
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

	it("asks again soon after a failed read instead of holding the failure for the window", async () => {
		/* 14 Oct: one failed read was cached for the full 30 s, then a
		   restart's 502 cached another, and an agent got a run of
		   "UNVERIFIED" replies from a home that was answering fine. */
		vi.useFakeTimers();
		try {
			let fail = true;
			const getConfig = vi.fn(async () => {
				if (fail) throw new HaApiError("responded 502", 502, "");
				return { location_name: "GamlaBio" };
			});
			const warn = vi.fn();
			const identity = createIdentityReader({
				instances: { activeId: () => "748d339f" },
				rest: { getConfig },
				logger: { warn }
			} as unknown as ToolContext);
			expect((await identity()).error).toMatch(/502/);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("502"));
			fail = false;
			expect((await identity()).error).toBeDefined(); // within the short hold
			vi.advanceTimersByTime(3_100);
			expect((await identity()).home).toBe("GamlaBio");
			vi.advanceTimersByTime(10_000);
			await identity();
			expect(getConfig).toHaveBeenCalledTimes(2); // success still holds for the window
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries once when the request got no answer at all", async () => {
		const getConfig = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce({ location_name: "Home" });
		const identity = createIdentityReader({
			instances: { activeId: () => "748d339f" },
			rest: { getConfig }
		} as unknown as ToolContext);
		expect((await identity()).home).toBe("Home");
		expect(getConfig).toHaveBeenCalledTimes(2);
	});

	it("does not retry a real HTTP answer", async () => {
		const getConfig = vi.fn(async () => {
			throw new HaApiError("responded 403", 403, "");
		});
		const identity = createIdentityReader({
			instances: { activeId: () => "748d339f" },
			rest: { getConfig }
		} as unknown as ToolContext);
		expect((await identity()).error).toMatch(/403/);
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

describe("naming the home on any call routes that call", () => {
	/* Reads answered from the wrong house three times: another window of the
	   same client had moved the shared starting choice, and "entity not found"
	   or an empty history looked like real answers. Naming the home used to
	   refuse such a call; now it sends the call there (Nov 2026: "there's no
	   way to read the standby without changing the instance remembered for
	   the whole API key"), for that call only. */
	const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

	function harness(brokered: boolean) {
		const env: Record<string, string> = brokered
			? {
					HA_TOKEN: "",
					VOMEHOME_TOKEN: "vh_test",
					VOMEHOME_API_URL: "https://portal.test",
					VOMEHOME_INSTANCE_ID: "rly-1",
					VOMEHOME_INSTANCES: JSON.stringify([
						{ id: "rly-1", write: true, config: true },
						{ id: "rly-2", write: false, config: false }
					])
				}
			: { HA_URL: "http://ha.local:8123", HA_TOKEN: "tok", HA_ALLOW_WRITE: "true" };
		const config = loadConfig(env);
		const direct = { getConfig: async () => ({ location_name: "Direct" }) } as unknown as HaRestClient;
		const instances = createInstanceManager(config, logger, brokered ? undefined : direct);
		const ctx = { config, logger, instances, rest: instances.rest } as unknown as ToolContext;
		const registered = new Map<string, { config: any; handler: (...a: any[]) => Promise<CallToolResult> }>();
		const fake = {
			registerTool: (name: string, cfg: unknown, handler: any) => registered.set(name, { config: cfg, handler })
		} as unknown as McpServer;
		const server = withInstanceStamp(fake, ctx);
		const seen: Array<{ args: unknown; active: string; write: boolean }> = [];
		const handler = vi.fn(async (args: unknown) => {
			seen.push({ args, active: instances.activeId(), write: instances.currentSafety().allowWrite });
			// The tool's own Home Assistant call, through the shared client.
			const home = (await ctx.rest.getConfig()) as { location_name?: string };
			return { content: [{ type: "text" as const, text: home.location_name ?? "" }] };
		});
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				urls.push(String(url));
				const id = /\/instances\/([^/]+)\/ha/.exec(String(url))?.[1];
				return new Response(JSON.stringify({ location_name: id === "rly-2" ? "Standby" : "Main" }), { status: 200 });
			})
		);
		const call = (name: string, args: Record<string, unknown>) => registered.get(name)!.handler(args, {});
		return { server, registered, handler, seen, instances, urls, call };
	}

	afterEach(() => vi.unstubAllGlobals());

	const stampOf = (result: CallToolResult) => String((result.content.at(-1) as any).text);

	it("routes a read to the named instance without moving the session or its remembered choice", async () => {
		const { server, handler, seen, instances, urls, call } = harness(true);
		server.registerTool("ha_get_history", { inputSchema: { entity_ids: {} } } as any, handler as any);
		const result = await call("ha_get_history", { entity_ids: ["x"], instance_id: "rly-2" });
		expect(result.isError).toBeFalsy();
		expect((result.content[0] as any).text).toBe("Standby");
		expect(seen[0]).toMatchObject({ args: { entity_ids: ["x"] }, active: "rly-2" });
		expect(urls.every((url) => url.includes("/instances/rly-2/"))).toBe(true);
		// The session is where it was, and nothing counts as a choice to remember.
		expect(instances.activeId()).toBe("rly-1");
		expect(instances.sessionActiveId()).toBe("rly-1");
		expect(instances.chosenId()).toBeNull();
		// The stamp names where the call went, and that the session did not move.
		expect(stampOf(result)).toContain("target=rly-2");
		expect(stampOf(result)).toContain('home="Standby"');
		expect(stampOf(result)).toContain("(this call only; session still on rly-1)");
	});

	it("says nothing extra when the named instance is the session's own", async () => {
		const { server, handler, call } = harness(true);
		server.registerTool("ha_get_history", { inputSchema: { entity_ids: {} } } as any, handler as any);
		const result = await call("ha_get_history", { entity_ids: ["x"], instance_id: "rly-1" });
		expect(stampOf(result)).toContain("target=rly-1");
		expect(stampOf(result)).not.toContain("this call only");
	});

	it("gives the call the target's own permission, as if it were active", async () => {
		const { server, handler, seen, call } = harness(true);
		server.registerTool("ha_call_service", { inputSchema: { domain: {} } } as any, handler as any);
		await call("ha_call_service", { domain: "light", instance_id: "rly-2" });
		await call("ha_call_service", { domain: "light" });
		expect(seen.map((s) => [s.active, s.write])).toEqual([
			["rly-2", false],
			["rly-1", true]
		]);
	});

	it("keeps concurrent calls on their own instances", async () => {
		const { server, handler, seen, call } = harness(true);
		server.registerTool("ha_get_state", { inputSchema: { entity_ids: {} } } as any, handler as any);
		const results = await Promise.all([
			call("ha_get_state", { entity_ids: ["a"], instance_id: "rly-2" }),
			call("ha_get_state", { entity_ids: ["b"] }),
			call("ha_get_state", { entity_ids: ["c"], instance_id: "rly-2" })
		]);
		expect(results.map((r) => (r.content[0] as any).text)).toEqual(["Standby", "Main", "Standby"]);
		expect(seen.map((s) => s.active).sort()).toEqual(["rly-1", "rly-2", "rly-2"]);
	});

	it("refuses an unknown instance with the ones it can use, without running the tool", async () => {
		const { server, handler, call, urls } = harness(true);
		server.registerTool("ha_get_history", { inputSchema: { entity_ids: {} } } as any, handler as any);
		const result = await call("ha_get_history", { entity_ids: ["x"], instance_id: "rly-9" });
		expect(result.isError).toBe(true);
		const text = (result.content[0] as any).text;
		expect(text).toContain('"rly-9" is not an instance this session can reach');
		expect(text).toContain("rly-1, rly-2");
		expect(handler).not.toHaveBeenCalled();
		expect(urls.filter((url) => url.includes("rly-9"))).toEqual([]);
	});

	it("routes a write tool's own required instance_id too, and leaves the argument in place", async () => {
		const { server, handler, seen, call, instances } = harness(true);
		server.registerTool("ha_write_config_file", { inputSchema: { instance_id: {}, path: {} } } as any, handler as any);
		expect((await call("ha_write_config_file", { instance_id: "rly-2", path: "x" })).isError).toBeFalsy();
		expect(seen[0]).toMatchObject({ args: { instance_id: "rly-2", path: "x" }, active: "rly-2", write: false });
		expect(instances.sessionActiveId()).toBe("rly-1");
	});

	it("refuses to route in direct mode, but leaves omitted ids and the write tools' own argument alone", async () => {
		const direct = harness(false);
		direct.server.registerTool("ha_list_entities", { inputSchema: {} } as any, direct.handler as any);
		const refused = await direct.call("ha_list_entities", { instance_id: "other" });
		expect(refused.isError).toBe(true);
		expect((refused.content[0] as any).text).toMatch(/one Home Assistant directly/);
		expect(direct.handler).not.toHaveBeenCalled();
		expect((await direct.call("ha_list_entities", {})).isError).toBeFalsy();
		expect((await direct.call("ha_list_entities", { instance_id: "(direct)" })).isError).toBeFalsy();
		direct.server.registerTool("ha_write_config_file", { inputSchema: { instance_id: {} } } as any, direct.handler as any);
		expect((await direct.call("ha_write_config_file", { instance_id: "direct" })).isError).toBeFalsy();
	});

	it("adds the optional argument to tools without one, and leaves the vomehome tools alone", async () => {
		const { server, registered, handler } = harness(true);
		server.registerTool("ha_list_entities", { inputSchema: {} } as any, handler as any);
		expect(registered.get("ha_list_entities")!.config.inputSchema).toHaveProperty("instance_id");
		server.registerTool("vomehome_use_instance", { inputSchema: { instance_id: {} } } as any, handler as any);
		expect(registered.get("vomehome_use_instance")!.config.inputSchema.instance_id).toEqual({});
		server.registerTool("vomehome_list_instances", { inputSchema: {} } as any, handler as any);
		expect(registered.get("vomehome_list_instances")!.config.inputSchema).not.toHaveProperty("instance_id");
	});
});

import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolUsage, withToolUsage } from "../src/cli/toolUsage.js";
import { SERVER_VERSION, setClientMode, userAgent } from "../src/version.js";

type Handler = (...args: unknown[]) => Promise<{ content: unknown[]; isError?: boolean }>;

/** A stand-in server that keeps the handler it was given, so a test can call it. */
function fakeServer(): { server: McpServer; handlers: Map<string, Handler> } {
	const handlers = new Map<string, Handler>();
	const server = {
		registerTool(name: string, _config: unknown, handler: Handler) {
			handlers.set(name, handler);
			return {};
		}
	} as unknown as McpServer;
	return { server, handlers };
}

describe("ToolUsage", () => {
	it("writes nothing for a quiet window", () => {
		expect(new ToolUsage().flush()).toBeNull();
	});

	it("sums calls per tool, busiest first, failures named, then starts a new window", () => {
		const usage = new ToolUsage();
		const start = Date.now();
		usage.record("ha_get_state", true);
		usage.record("ha_get_state", true);
		usage.record("ha_get_state", false);
		usage.record("ha_list_assist_pipelines", true);
		const line = usage.flush(start + 60 * 60 * 1000);
		expect(line).toBe(
			"Tool calls in the last 60 min: 4 total; ha_get_state=3 (1 failed), ha_list_assist_pipelines=1"
		);
		expect(usage.flush()).toBeNull();
	});

	it("keeps tool names and counts only: nothing about who called or with what", () => {
		const usage = new ToolUsage();
		usage.record("ha_call_service", true);
		const line = usage.flush() ?? "";
		expect(line).not.toMatch(/token|session|instance|user/i);
	});
});

describe("withToolUsage", () => {
	it("counts a reply, an error reply and a throw, and passes the throw on", async () => {
		const usage = new ToolUsage();
		const { server, handlers } = fakeServer();
		const counted = withToolUsage(server, usage);
		counted.registerTool("good", {}, (async () => ({ content: [] })) as never);
		counted.registerTool("bad", {}, (async () => ({ content: [], isError: true })) as never);
		counted.registerTool("boom", {}, (async () => {
			throw new Error("kaput");
		}) as never);

		await handlers.get("good")!();
		await handlers.get("bad")!();
		await expect(handlers.get("boom")!()).rejects.toThrow("kaput");

		expect(usage.flush()).toMatch(/3 total; bad=1 \(1 failed\), boom=1 \(1 failed\), good=1$/);
	});
});

describe("userAgent", () => {
	afterEach(() => setClientMode("stdio"));

	it("says stdio for a copy run from npm, hosted for serve", () => {
		setClientMode("stdio");
		expect(userAgent()).toBe(`home-assistant-mcp/${SERVER_VERSION} (stdio)`);
		setClientMode("hosted");
		expect(userAgent()).toBe(`home-assistant-mcp/${SERVER_VERSION} (hosted)`);
	});
});

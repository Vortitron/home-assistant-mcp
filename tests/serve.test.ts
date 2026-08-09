import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bearerToken, startMcpHttpServer } from "../src/cli/serve.js";
import type { RunningMcpServer, ServeArgs } from "../src/cli/serve.js";
import type { Logger } from "../src/logger.js";

const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {}
};

const GOOD_TOKEN = "vh_good_token";
const NO_INSTANCE_TOKEN = "vh_scopeless_token";

interface FakePortal {
	url: string;
	close: () => Promise<void>;
}

/**
 * Stands in for the VomeHome portal: just enough of `/api/v1/instances` for a
 * session to discover what its token can reach, plus one brokered HA endpoint,
 * so tests exercise the real request path rather than a mocked client.
 */
async function makeFakePortal(): Promise<FakePortal> {
	const server = http.createServer((req, res) => {
		const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
		const json = (status: number, body: unknown): void => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (token !== GOOD_TOKEN && token !== NO_INSTANCE_TOKEN) {
			json(401, { error: "bad token" });
			return;
		}
		if (req.url === "/api/v1/instances") {
			json(200, {
				instances:
					token === NO_INSTANCE_TOKEN
						? []
						: [{ id: "inst-one", name: "Home", status: "running" }]
			});
			return;
		}
		if (req.url === "/api/v1/instances/inst-one/ha/config") {
			json(200, { version: "2026.8.0", location_name: "Test Home" });
			return;
		}
		json(404, { error: `no route ${req.url}` });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}

function serveArgs(apiUrl: string): ServeArgs {
	return {
		port: 0,
		host: "127.0.0.1",
		path: "/mcp",
		apiUrl,
		sessionTtlMs: 60_000,
		logLevel: "error",
		help: false
	};
}

/** Raw POST to the MCP endpoint, bypassing the SDK client so error paths show. */
async function post(
	url: string,
	body: unknown,
	headers: Record<string, string>
): Promise<{ status: number; body: string }> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...headers
		},
		body: JSON.stringify(body)
	});
	return { status: response.status, body: await response.text() };
}

const initBody = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "1.0.0" }
	}
};

describe("bearerToken", () => {
	const req = (authorization?: string): http.IncomingMessage =>
		({ headers: authorization === undefined ? {} : { authorization } }) as http.IncomingMessage;

	it("reads a well-formed header", () => {
		expect(bearerToken(req("Bearer abc123"))).toBe("abc123");
	});

	it("is case-insensitive on the scheme and trims padding", () => {
		expect(bearerToken(req("  bearer   abc123  "))).toBe("abc123");
	});

	it("returns empty for a missing or non-bearer header", () => {
		expect(bearerToken(req())).toBe("");
		expect(bearerToken(req("Basic abc123"))).toBe("");
		expect(bearerToken(req("Bearer"))).toBe("");
	});
});

describe("MCP HTTP server", () => {
	let portal: FakePortal;
	let server: RunningMcpServer;
	let endpoint: string;

	beforeEach(async () => {
		portal = await makeFakePortal();
		server = await startMcpHttpServer(serveArgs(portal.url), silentLogger);
		endpoint = `http://127.0.0.1:${server.port}/mcp`;
	});

	afterEach(async () => {
		await server.close();
		await portal.close();
	});

	it("serves a health check without a token", async () => {
		const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ ok: true, sessions: 0 });
	});

	it("rejects a request with no bearer token", async () => {
		const { status, body } = await post(endpoint, initBody, {});
		expect(status).toBe(401);
		expect(body).toContain("Missing bearer token");
	});

	it("reports a token the portal rejects, rather than dropping the connection", async () => {
		const { status, body } = await post(endpoint, initBody, { Authorization: "Bearer nope" });
		expect(status).toBe(401);
		expect(body).toContain("VomeHome rejected this token");
	});

	it("explains a token that can reach no instances", async () => {
		const { status, body } = await post(endpoint, initBody, {
			Authorization: `Bearer ${NO_INSTANCE_TOKEN}`
		});
		expect(status).toBe(403);
		expect(body).toContain("cannot reach any Home Assistant instance");
	});

	it("refuses a non-initialize request that opens no session", async () => {
		const { status, body } = await post(
			endpoint,
			{ jsonrpc: "2.0", id: 1, method: "tools/list" },
			{ Authorization: `Bearer ${GOOD_TOKEN}` }
		);
		expect(status).toBe(400);
		expect(body).toContain("initialize request");
	});

	it("rejects an unknown session id", async () => {
		const { status, body } = await post(endpoint, initBody, {
			Authorization: `Bearer ${GOOD_TOKEN}`,
			"mcp-session-id": "11111111-2222-3333-4444-555555555555"
		});
		expect(status).toBe(404);
		expect(body).toContain("Unknown or expired MCP session");
	});

	it("binds a session to the token that opened it", async () => {
		const opened = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${GOOD_TOKEN}`
			},
			body: JSON.stringify(initBody)
		});
		const sessionId = opened.headers.get("mcp-session-id");
		expect(sessionId).toBeTruthy();
		await opened.body?.cancel();

		// A different token must not be able to drive somebody else's session.
		const { status, body } = await post(
			endpoint,
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			{ Authorization: `Bearer ${NO_INSTANCE_TOKEN}`, "mcp-session-id": sessionId as string }
		);
		expect(status).toBe(403);
		expect(body).toContain("different token");
	});

	it("completes a full session: discovery, tool list and a brokered HA call", async () => {
		const client = new Client({ name: "test", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
			requestInit: { headers: { Authorization: `Bearer ${GOOD_TOKEN}` } }
		});
		await client.connect(transport);

		const { tools } = await client.listTools();
		expect(tools.length).toBeGreaterThan(40);
		expect(tools.map((tool) => tool.name)).toContain("ha_get_config");
		expect(server.sessionCount()).toBe(1);

		// Instance discovery must have selected the token's only instance, so a
		// brokered call works without an explicit vomehome_use_instance first.
		const result = await client.callTool({ name: "ha_get_config", arguments: {} });
		const text = (result.content as { text: string }[])[0]?.text ?? "";
		expect(text).toContain("2026.8.0");
		expect(text).toContain("Test Home");

		await client.close();
	});
});

/**
 * `home-assistant-mcp serve` — remote (multi-tenant) MCP over Streamable HTTP.
 *
 * Why this exists: the stdio mode requires every user to have Node and a
 * working `npx` on their PATH, which is exactly what breaks on machines using
 * nvm/fnm (an editor spawns the server with a minimal environment, or a login
 * shell resets PATH, and the client sees only "Connection closed"). Hosting the
 * server means a client needs nothing but a URL and a token.
 *
 * Nothing is given up by moving the process to the server: in brokered mode the
 * MCP is a pure translation layer that calls the VomeHome HTTP API, and all the
 * policy — scope checks, the sensitive-domain deny-list, ownership re-checks and
 * audit logging — is already enforced server-side by the portal.
 *
 * Tenancy model: one MCP session === one VomeHome token. The token arrives as a
 * bearer credential on `initialize`, and its {@link ToolContext} (clients,
 * instance registry, active instance) lives only for that session. Sessions are
 * bound to the token that created them, so a leaked session id cannot be driven
 * by a different token.
 */
import * as http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { loadConfig } from "../config.js";
import type { Logger, LogLevel } from "../logger.js";
import { createToolContext } from "../context.js";
import { createVomeHomeClient, VomeHomeError } from "../vomehome/client.js";
import { registerAllTools } from "../tools/index.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

/** A problem with the caller's token, reported as 401/403 rather than 500. */
class TokenError extends Error {
	readonly status: number;

	constructor(message: string, status = 403) {
		super(message);
		this.name = "TokenError";
		this.status = status;
	}
}

const DEFAULT_PORT = 3400;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/mcp";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
/** Refuse oversized bodies before parsing; MCP requests are small. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface ServeArgs {
	port: number;
	host: string;
	path: string;
	/** VomeHome portal base URL every session brokers through. */
	apiUrl: string;
	sessionTtlMs: number;
	logLevel: LogLevel;
	help: boolean;
}

interface Session {
	transport: StreamableHTTPServerTransport;
	server: McpServer;
	close: () => Promise<void>;
	/** SHA-256 of the bearer token that opened this session (never the token). */
	tokenHash: Buffer;
	/** Hex form of {@link tokenHash}, used to key remembered state per token. */
	tokenKey: string;
	/** The instance this session is currently targeting. */
	activeId: () => string;
	lastSeen: number;
}

function parseArgs(argv: string[], config: Config): ServeArgs {
	const args: ServeArgs = {
		port: Number(process.env.MCP_HTTP_PORT ?? DEFAULT_PORT),
		host: process.env.MCP_HTTP_HOST ?? DEFAULT_HOST,
		path: process.env.MCP_HTTP_PATH ?? DEFAULT_PATH,
		apiUrl: config.vomehome.apiUrl,
		sessionTtlMs: DEFAULT_SESSION_TTL_MS,
		logLevel: config.logLevel,
		help: false
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--port") {
			args.port = Number(argv[++i]);
		} else if (arg === "--host") {
			args.host = argv[++i] ?? args.host;
		} else if (arg === "--path") {
			args.path = argv[++i] ?? args.path;
		} else if (arg === "--api-url") {
			args.apiUrl = (argv[++i] ?? args.apiUrl).replace(/\/+$/, "");
		} else if (arg === "--session-ttl") {
			args.sessionTtlMs = Number(argv[++i]) * 1000;
		} else if (arg === "--help" || arg === "-h") {
			args.help = true;
		}
	}
	return args;
}

function line(text = ""): void {
	process.stdout.write(`${text}\n`);
}

function printUsage(): void {
	line("Usage: home-assistant-mcp serve [--port 3400] [--host 127.0.0.1] [--path /mcp]");
	line("                                [--api-url https://vome.io] [--session-ttl 1800]");
	line("");
	line("Serves MCP over Streamable HTTP so clients need no local Node install.");
	line("Each session authenticates with a VomeHome API token:");
	line("");
	line('  Authorization: Bearer <vomehome-token>');
	line("");
	line("Intended to sit behind a TLS-terminating reverse proxy, which is why it");
	line("binds to loopback by default. GET /healthz reports liveness.");
}

/**
 * Bearer token from the Authorization header, or "" when absent/malformed.
 * Exported for tests.
 */
export function bearerToken(req: http.IncomingMessage): string {
	const header = req.headers.authorization;
	if (typeof header !== "string") {
		return "";
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? (match[1] ?? "").trim() : "";
}

function hashToken(token: string): Buffer {
	return createHash("sha256").update(token).digest();
}

/** Constant-time compare so session binding cannot be probed by timing. */
function sameToken(a: Buffer, b: Buffer): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}

/**
 * JSON-RPC-shaped error, as MCP clients expect even for transport-level
 * failures — a bare HTTP status tends to surface as an unhelpful
 * "Connection closed" in the client UI.
 */
function sendRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
	if (status === 401) {
		res.setHeader("WWW-Authenticate", 'Bearer realm="VomeHome", error="invalid_token"');
	}
	sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request body too large."));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (raw.length === 0) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch (error) {
				reject(new Error(`Invalid JSON body: ${(error as Error).message}`));
			}
		});
		req.on("error", reject);
	});
}

/** A listening MCP HTTP server, so callers (and tests) can shut it down. */
export interface RunningMcpServer {
	/** Actual bound port — resolves an ephemeral `port: 0` to a real number. */
	readonly port: number;
	/** Live session count, as reported by /healthz. */
	sessionCount(): number;
	close(): Promise<void>;
}

/**
 * Starts the HTTP server and returns once it is listening.
 *
 * Exported separately from {@link runServe} so tests can drive the real request
 * path against an ephemeral port without the process-level signal handling.
 */
export async function startMcpHttpServer(args: ServeArgs, logger: Logger): Promise<RunningMcpServer> {
	const sessions = new Map<string, Session>();

	/**
	 * Session environment, shaped exactly like the stdio one so both transports
	 * go through the same `loadConfig` rules. The token is the only per-tenant
	 * input; write/config flags are deliberately left unset, which in brokered
	 * mode means "defer to the API key's server-side scopes".
	 */
	function sessionEnv(token: string, instanceId: string, instanceIds: string[]): NodeJS.ProcessEnv {
		return {
			VOMEHOME_TOKEN: token,
			VOMEHOME_API_URL: args.apiUrl,
			VOMEHOME_INSTANCE_ID: instanceId,
			VOMEHOME_INSTANCES: instanceIds.length > 0 ? JSON.stringify(instanceIds) : "",
			LOG_LEVEL: args.logLevel
		} as NodeJS.ProcessEnv;
	}

	/**
	 * Builds the per-session context, discovering the token's instances first.
	 *
	 * The discovery call is load-bearing rather than a convenience: brokered mode
	 * only engages when at least one instance is known (see `loadConfig`), and a
	 * hosted server has no `VOMEHOME_INSTANCE_ID` to fall back on. Asking the
	 * portal what this token can reach both turns brokering on and lets the first
	 * `ha_*` call work without the client having to call `vomehome_use_instance`.
	 */
	/**
	 * Last instance each token selected with `vomehome_use_instance`, keyed by
	 * token hash and outliving the session that chose it.
	 *
	 * Sessions are not permanent: an idle one is reaped, a transport can
	 * reconnect, and the service can restart. Each of those builds a fresh
	 * context, which used to silently reset the active instance back to the
	 * first one the token could see — so an agent mid-conversation would
	 * carry on querying a *different* Home Assistant and quietly get answers
	 * about the wrong house. The stdio server never had this failure mode
	 * because it was one long-lived process per client.
	 */
	const lastActiveByToken = new Map<string, { instanceId: string; at: number }>();

	async function contextForToken(token: string): Promise<ReturnType<typeof createToolContext>> {
		// Bootstrap config: the VomeHome client needs only a token and a URL, so
		// it can be built before any instance is known.
		const bootstrap = loadConfig(sessionEnv(token, "", []));
		const ids = (await createVomeHomeClient(bootstrap, logger).listInstances())
			.map((instance) => instance.id)
			.filter((id) => id.length > 0);
		if (ids.length === 0) {
			throw new TokenError(
				"This token cannot reach any Home Assistant instance. Check the token's instance scopes in the VomeHome portal under Account -> API tokens."
			);
		}
		// Resume the token's last explicit choice, so a reconnect does not
		// silently retarget a conversation at a different house. Only honoured
		// while the instance is still reachable by this token — a revoked grant
		// must not be resurrected from memory.
		const remembered = lastActiveByToken.get(hashToken(token).toString("hex"));
		const active = remembered && ids.includes(remembered.instanceId) ? remembered.instanceId : (ids[0] as string);
		if (remembered && active === remembered.instanceId && ids[0] !== active) {
			logger.debug(`Restored active instance ${active} for a reconnecting token`);
		}
		return createToolContext(loadConfig(sessionEnv(token, active, ids)), logger);
	}

	async function dropSession(sessionId: string): Promise<void> {
		const session = sessions.get(sessionId);
		if (!session) {
			return;
		}
		sessions.delete(sessionId);
		await session.close();
		logger.debug(`MCP session ${sessionId} closed (${sessions.size} open)`);
	}

	async function openSession(token: string, body: unknown, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const ctx = await contextForToken(token);
		const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
		registerAllTools(server, ctx);

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (sessionId) => {
				sessions.set(sessionId, {
					transport,
					server,
					close: async () => {
						await ctx.ws.close().catch(() => undefined);
						await server.close().catch(() => undefined);
					},
					tokenHash: hashToken(token),
					tokenKey: hashToken(token).toString("hex"),
					activeId: () => ctx.instances.activeId(),
					lastSeen: Date.now()
				});
				logger.info(`MCP session ${sessionId} opened (${sessions.size} open)`);
			},
			onsessionclosed: (sessionId) => {
				void dropSession(sessionId);
			}
		});
		transport.onclose = () => {
			const id = transport.sessionId;
			if (id) {
				void dropSession(id);
			}
		};

		await server.connect(transport);
		await transport.handleRequest(req, res, body);
	}

	const httpServer = http.createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

			if (url.pathname === "/healthz") {
				sendJson(res, 200, {
					ok: true,
					server: SERVER_NAME,
					version: SERVER_VERSION,
					sessions: sessions.size
				});
				return;
			}

			if (url.pathname !== args.path) {
				sendRpcError(res, 404, -32601, `No MCP endpoint at ${url.pathname}. Use ${args.path}.`);
				return;
			}

			const token = bearerToken(req);
			if (!token) {
				sendRpcError(
					res,
					401,
					-32001,
					"Missing bearer token. Send 'Authorization: Bearer <vomehome-token>' — mint one in the VomeHome portal under Account -> API tokens."
				);
				return;
			}

			const sessionId = req.headers["mcp-session-id"];
			const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

			if (existing) {
				// Bind the session to its originating token: possessing a session id
				// must never be enough to act as somebody else.
				if (!sameToken(existing.tokenHash, hashToken(token))) {
					sendRpcError(res, 403, -32002, "This MCP session belongs to a different token.");
					return;
				}
				existing.lastSeen = Date.now();
				await existing.transport.handleRequest(req, res, req.method === "POST" ? await readBody(req) : undefined);
				// Remember whatever instance the session is on now. Reading it
				// back after the request catches a vomehome_use_instance without
				// the transport needing to know that tool exists.
				lastActiveByToken.set(existing.tokenKey, {
					instanceId: existing.activeId(),
					at: Date.now()
				});
				return;
			}

			if (typeof sessionId === "string" && sessionId.length > 0) {
				sendRpcError(res, 404, -32001, "Unknown or expired MCP session. Re-initialize to continue.");
				return;
			}

			if (req.method !== "POST") {
				sendRpcError(res, 405, -32000, "Open a session with an initialize request first.");
				return;
			}

			const body = await readBody(req);
			if (!isInitializeRequest(body)) {
				sendRpcError(res, 400, -32000, "Expected an initialize request to open a new MCP session.");
				return;
			}

			await openSession(token, body, req, res);
		})().catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`Request failed: ${message}`);
			if (res.headersSent) {
				res.end();
				return;
			}
			// Distinguish "your token is wrong" from "we broke", so the client shows
			// something actionable instead of a bare connection failure.
			if (error instanceof TokenError) {
				sendRpcError(res, error.status, -32002, message);
			} else if (error instanceof VomeHomeError && (error.status === 401 || error.status === 403)) {
				sendRpcError(
					res,
					401,
					-32001,
					`VomeHome rejected this token (status ${error.status}). Mint a new one in the portal under Account -> API tokens.`
				);
			} else if (error instanceof VomeHomeError) {
				sendRpcError(res, 502, -32603, `VomeHome portal error: ${message}`);
			} else {
				sendRpcError(res, 500, -32603, `Internal error: ${message}`);
			}
		});
	});

	// Idle sessions hold a WebSocket to Home Assistant open, so reap them rather
	// than waiting for a client that may never send DELETE.
	const sweep = setInterval(() => {
		const cutoff = Date.now() - args.sessionTtlMs;
		for (const [id, session] of sessions) {
			if (session.lastSeen < cutoff) {
				logger.info(`MCP session ${id} expired after inactivity`);
				void dropSession(id);
			}
		}
	}, SWEEP_INTERVAL_MS);
	sweep.unref();

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(args.port, args.host, resolve);
	});
	const address = httpServer.address();
	const boundPort = typeof address === "object" && address !== null ? address.port : args.port;
	logger.info(
		`${SERVER_NAME} v${SERVER_VERSION} serving MCP over HTTP on http://${args.host}:${boundPort}${args.path} (brokering via ${args.apiUrl})`
	);

	return {
		port: boundPort,
		sessionCount: () => sessions.size,
		close: async () => {
			clearInterval(sweep);
			await Promise.all([...sessions.keys()].map((id) => dropSession(id)));
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		}
	};
}

export async function runServe(argv: string[], config: Config, logger: Logger): Promise<number> {
	const args = parseArgs(argv, config);
	if (args.help) {
		printUsage();
		return 0;
	}
	if (!Number.isFinite(args.port) || args.port <= 0) {
		logger.error("--port must be a positive number.");
		return 1;
	}
	if (!/^https?:\/\//i.test(args.apiUrl)) {
		logger.error(
			`--api-url must start with http:// or https:// (got '${args.apiUrl}'). Set VOMEHOME_API_URL or pass --api-url.`
		);
		return 1;
	}

	const server = await startMcpHttpServer(args, logger);
	await new Promise<void>((resolve) => {
		const shutdown = (signal: string): void => {
			logger.info(`Received ${signal}, shutting down`);
			void server.close().finally(resolve);
		};
		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));
	});
	return 0;
}

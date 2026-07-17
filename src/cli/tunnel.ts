import * as net from "node:net";
import { WebSocket } from "ws";
import type { Logger } from "../logger.js";

interface TunnelArgs {
	token: string;
	localPort: number;
	relay: string;
}

const DEFAULT_RELAY = "wss://sync.vome.io";

function parseArgs(argv: string[]): TunnelArgs {
	let token = "";
	let localPort = 0;
	let relay = DEFAULT_RELAY;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--token") {
			token = argv[++i] ?? "";
		} else if (arg === "--local-port") {
			localPort = Number(argv[++i]);
		} else if (arg === "--relay") {
			relay = argv[++i] ?? relay;
		}
	}
	return { token, localPort, relay };
}

function line(text = ""): void {
	process.stdout.write(`${text}\n`);
}

function printUsage(): void {
	line("Usage: home-assistant-mcp tunnel --token <jwt> --local-port <port> [--relay wss://sync.vome.io]");
	line("");
	line("Get a token from Home Assistant: Developer Tools -> Actions -> vomesync.mint_lan_tcp_token");
	line("(or the Vome App's ingress panel -> LAN tunnels -> Get tunnel token).");
	line("");
	line("The token is scoped to one linked Home Assistant + one tcp-scheme LAN route");
	line("(e.g. an RDP host) and short-lived. Point any TCP client — mstsc, Remmina,");
	line("anything — at 127.0.0.1:<local-port> once the tunnel is listening.");
}

/**
 * `home-assistant-mcp tunnel` — a generic raw-TCP-over-WebSocket tunnel client.
 *
 * Opens a local listener on 127.0.0.1 only (this exists to replace opening a
 * port-forward, so it must never itself become LAN/internet-reachable) and,
 * per accepted local connection, opens a WebSocket to `<relay>/ws/tcp`
 * presenting `token` as a bearer header, then pumps bytes both ways. The
 * server side (VomeSync's websocket/tcpTunnelManager.js) derives which Home
 * Assistant + LAN route slug to bridge to entirely from the verified token —
 * this client doesn't need to know either. RDP is the first use case but
 * nothing here is RDP-specific.
 */
export async function runTunnel(argv: string[], logger: Logger): Promise<number> {
	const { token, localPort, relay } = parseArgs(argv);
	if (!token || !localPort || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
		printUsage();
		return 1;
	}
	const wsUrl = `${relay.replace(/\/+$/, "")}/ws/tcp`;

	const server = net.createServer((socket) => {
		const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
		let opened = false;

		ws.on("open", () => {
			opened = true;
		});
		ws.on("message", (data, isBinary) => {
			if (isBinary && Buffer.isBuffer(data)) {
				socket.write(data);
			}
		});
		ws.on("close", (code, reason) => {
			if (!opened) {
				logger.error(`Tunnel rejected (code ${code}): ${reason.toString() || "no reason given"}`);
			}
			socket.destroy();
		});
		ws.on("error", (err) => {
			logger.error(`Tunnel WebSocket error: ${err.message}`);
			socket.destroy();
		});

		socket.on("data", (chunk) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(chunk);
			}
		});
		socket.on("close", () => {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
				ws.close();
			}
		});
		socket.on("error", (err) => {
			logger.debug(`Local connection error: ${err.message}`);
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
				ws.close();
			}
		});
	});

	return new Promise((resolve) => {
		server.on("error", (err) => {
			logger.error(`Local listener error: ${err.message}`);
			resolve(1);
		});
		server.listen(localPort, "127.0.0.1", () => {
			line(`Tunnel listening on 127.0.0.1:${localPort} -> ${wsUrl}`);
			line("Point your client at that address. Ctrl+C to stop.");
		});
		process.on("SIGINT", () => {
			line("");
			line("Stopping tunnel.");
			server.close(() => resolve(0));
		});
	});
}

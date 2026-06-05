import WebSocket from "ws";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { HaArea, HaDevice, HaEntityRegistryEntry } from "./types.js";

/**
 * Minimal Home Assistant WebSocket client. Home Assistant exposes the area,
 * device and entity registries *only* over the WebSocket API, so we need this in
 * addition to the REST client. The client connects lazily, authenticates, then
 * multiplexes request/response pairs by message id.
 */

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface HaWsClient {
	sendCommand<T = unknown>(command: Record<string, unknown>): Promise<T>;
	listAreas(): Promise<HaArea[]>;
	listDevices(): Promise<HaDevice[]>;
	listEntities(): Promise<HaEntityRegistryEntry[]>;
	close(): Promise<void>;
}

function toWebSocketUrl(httpUrl: string): string {
	if (/^https:/i.test(httpUrl)) {
		return `wss:${httpUrl.slice("https:".length)}/api/websocket`;
	}
	if (/^http:/i.test(httpUrl)) {
		return `ws:${httpUrl.slice("http:".length)}/api/websocket`;
	}
	return `${httpUrl}/api/websocket`;
}

export function createHaWsClient(config: Config, logger: Logger): HaWsClient {
	const wsUrl = toWebSocketUrl(config.haUrl);
	const pending = new Map<number, PendingRequest>();
	let socket: WebSocket | null = null;
	let connecting: Promise<WebSocket> | null = null;
	let nextId = 1;

	function rejectAllPending(reason: Error): void {
		for (const [, request] of pending) {
			clearTimeout(request.timer);
			request.reject(reason);
		}
		pending.clear();
	}

	function handleResult(message: { id?: number; success?: boolean; result?: unknown; error?: unknown }): void {
		if (typeof message.id !== "number") {
			return;
		}
		const request = pending.get(message.id);
		if (!request) {
			return;
		}
		pending.delete(message.id);
		clearTimeout(request.timer);
		if (message.success) {
			request.resolve(message.result);
		} else {
			request.reject(new Error(`WebSocket command failed: ${JSON.stringify(message.error)}`));
		}
	}

	function connect(): Promise<WebSocket> {
		if (socket && socket.readyState === WebSocket.OPEN) {
			return Promise.resolve(socket);
		}
		if (connecting) {
			return connecting;
		}
		connecting = new Promise<WebSocket>((resolve, reject) => {
			let settled = false;
			const ws = new WebSocket(wsUrl);
			const handshakeTimer = setTimeout(() => {
				if (!settled) {
					settled = true;
					connecting = null;
					ws.terminate();
					reject(new Error(`WebSocket auth timed out after ${config.timeoutMs}ms`));
				}
			}, config.timeoutMs);

			ws.on("message", (raw: WebSocket.RawData) => {
				let message: { type?: string; [key: string]: unknown };
				try {
					message = JSON.parse(raw.toString());
				} catch {
					logger.warn("Ignoring non-JSON WebSocket frame");
					return;
				}
				switch (message.type) {
					case "auth_required":
						ws.send(JSON.stringify({ type: "auth", access_token: config.haToken }));
						break;
					case "auth_ok":
						clearTimeout(handshakeTimer);
						settled = true;
						socket = ws;
						connecting = null;
						logger.debug("Home Assistant WebSocket authenticated");
						resolve(ws);
						break;
					case "auth_invalid":
						clearTimeout(handshakeTimer);
						settled = true;
						connecting = null;
						ws.close();
						reject(new Error(`WebSocket auth invalid: ${String(message.message ?? "")}`));
						break;
					case "result":
						handleResult(message as Parameters<typeof handleResult>[0]);
						break;
					default:
						break;
				}
			});

			ws.on("error", (error: Error) => {
				logger.debug(`WebSocket error: ${error.message}`);
				if (!settled) {
					settled = true;
					clearTimeout(handshakeTimer);
					connecting = null;
					reject(error);
				}
				rejectAllPending(error);
			});

			ws.on("close", () => {
				if (socket === ws) {
					socket = null;
				}
				if (!settled) {
					settled = true;
					clearTimeout(handshakeTimer);
					connecting = null;
					reject(new Error("WebSocket closed during authentication"));
				}
				rejectAllPending(new Error("WebSocket connection closed"));
			});
		});
		return connecting;
	}

	async function sendCommand<T>(command: Record<string, unknown>): Promise<T> {
		const ws = await connect();
		const id = nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`WebSocket command '${String(command.type)}' timed out`));
			}, config.timeoutMs);
			pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer
			});
			ws.send(JSON.stringify({ ...command, id }), (error) => {
				if (error) {
					clearTimeout(timer);
					pending.delete(id);
					reject(error);
				}
			});
		});
	}

	return {
		sendCommand,
		listAreas: () => sendCommand<HaArea[]>({ type: "config/area_registry/list" }),
		listDevices: () => sendCommand<HaDevice[]>({ type: "config/device_registry/list" }),
		listEntities: () =>
			sendCommand<HaEntityRegistryEntry[]>({ type: "config/entity_registry/list" }),
		close: () =>
			new Promise<void>((resolve) => {
				rejectAllPending(new Error("WebSocket client closed"));
				if (socket) {
					socket.once("close", () => resolve());
					socket.close();
					socket = null;
				} else {
					resolve();
				}
			})
	};
}

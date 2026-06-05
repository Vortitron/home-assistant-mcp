import WebSocket from "ws";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

/**
 * Client for the ESPHome Dashboard (the add-on / standalone web UI).
 *
 * - `/devices`, `/version`, `/edit` are plain REST (read + write YAML).
 * - `/validate`, `/compile`, `/upload`, `/run`, `/logs`, `/clean` are WebSocket
 *   command channels. The protocol is: connect, send
 *   `{ "type": "spawn", "configuration": "<file>.yaml" }`, then receive a stream
 *   of `{ "event": "line", "data": "..." }` frames terminated by
 *   `{ "event": "exit", "code": <int> }`.
 *
 * Note: the dashboard authorises WebSocket commands via its own cookie/XSRF when
 * a dashboard password is configured. Token / basic auth here only helps for
 * unauthenticated dashboards behind a reverse proxy. Password-protected
 * dashboards will reject the WebSocket spawn.
 */

const DEFAULT_COMMAND_TIMEOUT_MS = 300000;
const DEFAULT_MAX_LINES = 5000;

export type EsphomeStreamCommand = "validate" | "compile" | "upload" | "run" | "logs" | "clean";

export interface EsphomeCommandRequest {
	command: EsphomeStreamCommand;
	configuration: string;
	port?: string;
	timeoutMs?: number;
	maxLines?: number;
}

export interface EsphomeCommandResult {
	command: string;
	configuration: string;
	exitCode: number | null;
	output: string;
	truncated: boolean;
}

export interface EsphomeDashboardClient {
	isEnabled(): boolean;
	listDevices(): Promise<unknown>;
	getVersion(): Promise<unknown>;
	getConfig(configuration: string): Promise<string>;
	saveConfig(configuration: string, yaml: string): Promise<void>;
	runCommand(request: EsphomeCommandRequest): Promise<EsphomeCommandResult>;
}

export class EsphomeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EsphomeError";
	}
}

function buildAuthHeaders(config: Config): Record<string, string> {
	const headers: Record<string, string> = {};
	const { token, username, password } = config.esphome;
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	} else if (username && password) {
		const encoded = Buffer.from(`${username}:${password}`).toString("base64");
		headers.Authorization = `Basic ${encoded}`;
	}
	return headers;
}

function toWebSocketUrl(httpUrl: string, path: string): string {
	const base = /^https:/i.test(httpUrl)
		? `wss:${httpUrl.slice("https:".length)}`
		: /^http:/i.test(httpUrl)
			? `ws:${httpUrl.slice("http:".length)}`
			: httpUrl;
	return `${base}${path}`;
}

export function createEsphomeDashboardClient(
	config: Config,
	logger: Logger
): EsphomeDashboardClient {
	const baseUrl = config.esphome.dashboardUrl;

	function assertEnabled(): void {
		if (!config.esphome.enabled) {
			throw new EsphomeError(
				"ESPHome dashboard is not configured. Set ESPHOME_DASHBOARD_URL to enable ESPHome tools."
			);
		}
	}

	async function restRequest(
		path: string,
		options: { method?: string; body?: string; expectJson?: boolean } = {}
	): Promise<unknown> {
		assertEnabled();
		const method = options.method ?? "GET";
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
		try {
			const response = await fetch(`${baseUrl}${path}`, {
				method,
				headers: {
					...buildAuthHeaders(config),
					...(options.body !== undefined ? { "Content-Type": "application/yaml" } : {})
				},
				body: options.body,
				signal: controller.signal
			});
			const text = await response.text();
			if (!response.ok) {
				throw new EsphomeError(
					`ESPHome dashboard ${method} ${path} responded ${response.status} ${response.statusText}: ${text.slice(0, 200)}`
				);
			}
			if (options.expectJson) {
				return text.length > 0 ? JSON.parse(text) : undefined;
			}
			return text;
		} finally {
			clearTimeout(timeout);
		}
	}

	function runCommand(request: EsphomeCommandRequest): Promise<EsphomeCommandResult> {
		assertEnabled();
		const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		const maxLines = request.maxLines ?? DEFAULT_MAX_LINES;
		const url = toWebSocketUrl(baseUrl, `/${request.command}`);
		logger.debug(`ESPHome ${request.command} ${request.configuration}`);

		return new Promise<EsphomeCommandResult>((resolve, reject) => {
			const lines: string[] = [];
			let truncated = false;
			let settled = false;
			const ws = new WebSocket(url, { headers: buildAuthHeaders(config) });

			const overallTimer = setTimeout(() => {
				finish(null);
			}, timeoutMs);

			function finish(exitCode: number | null): void {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(overallTimer);
				try {
					ws.close();
				} catch {
					// ignore
				}
				resolve({
					command: request.command,
					configuration: request.configuration,
					exitCode,
					output: lines.join(""),
					truncated
				});
			}

			ws.on("open", () => {
				const spawn: Record<string, unknown> = {
					type: "spawn",
					configuration: request.configuration
				};
				if (request.port !== undefined) {
					spawn.port = request.port;
				}
				ws.send(JSON.stringify(spawn));
			});

			ws.on("message", (raw: WebSocket.RawData) => {
				let message: { event?: string; data?: string; code?: number };
				try {
					message = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (message.event === "line" && typeof message.data === "string") {
					if (lines.length < maxLines) {
						lines.push(message.data);
					} else {
						truncated = true;
					}
				} else if (message.event === "exit") {
					finish(typeof message.code === "number" ? message.code : null);
				}
			});

			ws.on("error", (error: Error) => {
				if (!settled) {
					settled = true;
					clearTimeout(overallTimer);
					reject(new EsphomeError(`ESPHome ${request.command} failed: ${error.message}`));
				}
			});

			ws.on("close", () => {
				finish(null);
			});
		});
	}

	return {
		isEnabled: () => config.esphome.enabled,
		listDevices: () => restRequest("/devices", { expectJson: true }),
		getVersion: () => restRequest("/version", { expectJson: true }),
		getConfig: async (configuration) =>
			(await restRequest(`/edit?configuration=${encodeURIComponent(configuration)}`)) as string,
		saveConfig: async (configuration, yaml) => {
			await restRequest(`/edit?configuration=${encodeURIComponent(configuration)}`, {
				method: "POST",
				body: yaml
			});
		},
		runCommand
	};
}

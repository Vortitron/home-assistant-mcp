import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type {
	HaApiStatus,
	HaCheckConfigResult,
	HaConfig,
	HaLogbookEntry,
	HaServiceDomain,
	HaState,
	HaTarget
} from "./types.js";
import type { HaWsClient } from "./wsClient.js";

/**
 * Thrown for any non-2xx Home Assistant REST response. Carries the HTTP status
 * and raw body so tools can surface a useful message back to the agent.
 */
/**
 * What POST /api/services/... answers: the states that changed, or -- for a
 * service that returns data, called with ?return_response -- those states
 * and the service's response together.
 */
export type HaServiceCallResult =
	| HaState[]
	| { changed_states?: HaState[]; service_response?: unknown };

/** The changed states and (if any) the service's own response, whichever shape came back. */
export function splitServiceResult(raw: unknown): { changed: HaState[]; response?: unknown } {
	if (Array.isArray(raw)) {
		return { changed: raw as HaState[] };
	}
	if (raw && typeof raw === "object") {
		const obj = raw as { changed_states?: unknown; service_response?: unknown };
		const changed = Array.isArray(obj.changed_states) ? (obj.changed_states as HaState[]) : [];
		return "service_response" in obj ? { changed, response: obj.service_response } : { changed };
	}
	return { changed: [] };
}

/** HA's 400 for a service that only works with ?return_response. */
export function wantsReturnResponse(error: unknown): boolean {
	return error instanceof HaApiError && error.status === 400 && /return_response/.test(error.body);
}

export class HaApiError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(message: string, status: number, body: string) {
		super(message);
		this.name = "HaApiError";
		this.status = status;
		this.body = body;
	}
}

/** A binary body, base64-encoded, and what kind of file it is. */
/** A running watch of some entities' states, and the token a reader follows it with (VomeHome only). */
export interface StateWatchGrant {
	job_id: string;
	token: string;
	read_url: string;
	expires_at: number;
	entity_ids: string[];
}

export interface HaImage {
	data: string;
	mimeType: string;
}

export interface HaRequestOptions {
	method?: string;
	body?: unknown;
	/** "binary" resolves to an {@link HaImage} rather than parsed text. */
	expect?: "json" | "text" | "binary";
	query?: Record<string, string | number | boolean | undefined>;
}

export interface HistoryParams {
	entityIds: string[];
	startTime?: string;
	endTime?: string;
	minimalResponse?: boolean;
	significantChangesOnly?: boolean;
}

export interface LogbookParams {
	startTime?: string;
	endTime?: string;
	entityId?: string;
}

/** Read + write surface of the Home Assistant REST API used by the tools. */
export interface HaRestClient {
	request<T = unknown>(path: string, options?: HaRequestOptions): Promise<T>;
	ping(): Promise<HaApiStatus>;
	getConfig(): Promise<HaConfig>;
	getStates(): Promise<HaState[]>;
	getState(entityId: string): Promise<HaState>;
	getServices(): Promise<HaServiceDomain[]>;
	callService(
		domain: string,
		service: string,
		data?: Record<string, unknown>,
		target?: HaTarget
	): Promise<HaServiceCallResult>;
	renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string>;
	checkConfig(): Promise<HaCheckConfigResult>;
	getErrorLog(): Promise<string>;
	/** A Supervisor-managed log (`core`, `host`, …, or `addon` with its slug) as text. */
	getSupervisorLog(target: string, addonSlug?: string): Promise<string>;
	/** A camera's current still, scaled by HA to ``width`` pixels wide. */
	getCameraImage(entityId: string, width?: number): Promise<HaImage>;
	/** Start a live watch of these entities, or renew the token for a running one (VomeHome only). */
	startStateWatch(entityIds: string[], jobId?: string): Promise<StateWatchGrant>;
	getLogbook(params: LogbookParams): Promise<HaLogbookEntry[]>;
	getHistory(params: HistoryParams): Promise<HaState[][]>;
	fireEvent(eventType: string, data?: Record<string, unknown>): Promise<{ message: string }>;
	getAutomationConfig(automationId: string): Promise<Record<string, unknown>>;
	upsertAutomationConfig(
		automationId: string,
		config: Record<string, unknown>
	): Promise<{ result: string }>;
	deleteAutomationConfig(automationId: string): Promise<{ result: string }>;
	getScriptConfig(scriptId: string): Promise<Record<string, unknown>>;
	upsertScriptConfig(scriptId: string, config: Record<string, unknown>): Promise<{ result: string }>;
	deleteScriptConfig(scriptId: string): Promise<{ result: string }>;
	/** Run one Home Assistant WebSocket command (brokered: allowlisted Lovelace subset). */
	sendWsCommand<T = unknown>(command: Record<string, unknown>): Promise<T>;
}

function buildQuery(query: HaRequestOptions["query"]): string {
	if (!query) {
		return "";
	}
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) {
			params.append(key, String(value));
		}
	}
	const serialised = params.toString();
	return serialised ? `?${serialised}` : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wrap raw bytes as an {@link HaImage}; a camera with no type is a JPEG. */
export function binaryResult(bytes: Buffer, contentType: string | null): HaImage {
	const mimeType = (contentType ?? "").split(";")[0]!.trim();
	return { data: bytes.toString("base64"), mimeType: mimeType.startsWith("image/") ? mimeType : "image/jpeg" };
}

export function createHaRestClient(
	config: Config,
	logger: Logger,
	wsClient?: HaWsClient
): HaRestClient {
	async function request<T>(path: string, options: HaRequestOptions = {}): Promise<T> {
		const method = options.method ?? "GET";
		const url = `${config.haUrl}${path}${buildQuery(options.query)}`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
		logger.debug(`HA ${method} ${path}`);
		try {
			const response = await fetch(url, {
				method,
				headers: {
					Authorization: `Bearer ${config.haToken}`,
					"Content-Type": "application/json"
				},
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: controller.signal
			});
			if (options.expect === "binary") {
				const bytes = Buffer.from(await response.arrayBuffer());
				if (!response.ok) {
					throw new HaApiError(
						`Home Assistant ${method} ${path} responded ${response.status} ${response.statusText}`,
						response.status,
						bytes.toString("utf8").slice(0, 2000)
					);
				}
				return binaryResult(bytes, response.headers.get("content-type")) as unknown as T;
			}
			const text = await response.text();
			if (!response.ok) {
				throw new HaApiError(
					`Home Assistant ${method} ${path} responded ${response.status} ${response.statusText}`,
					response.status,
					text
				);
			}
			if ((options.expect ?? "json") === "text") {
				return text as unknown as T;
			}
			return (text.length > 0 ? JSON.parse(text) : undefined) as T;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new HaApiError(
					`Home Assistant ${method} ${path} timed out after ${config.timeoutMs}ms`,
					0,
					""
				);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	async function callService(
		domain: string,
		service: string,
		data: Record<string, unknown> = {},
		target?: HaTarget
	): Promise<HaServiceCallResult> {
		const body: Record<string, unknown> = { ...data };
		if (target) {
			for (const [key, value] of Object.entries(target)) {
				if (value !== undefined) {
					body[key] = value;
				}
			}
		}
		const path = `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
		try {
			return await request<HaServiceCallResult>(path, { method: "POST", body });
		} catch (error) {
			// Services that return data (vomesync.subscribe_switch, ...) refuse
			// a plain call. Retry once asking for the response, as the VomeHome
			// broker does, so both transports behave the same.
			if (!wantsReturnResponse(error)) {
				throw error;
			}
			return request<HaServiceCallResult>(path, { method: "POST", body, query: { return_response: "true" } });
		}
	}

	async function renderTemplate(
		template: string,
		variables?: Record<string, unknown>
	): Promise<string> {
		const body: Record<string, unknown> = { template };
		if (variables && Object.keys(variables).length > 0) {
			body.variables = variables;
		}
		return request<string>("/api/template", { method: "POST", body, expect: "text" });
	}

	function getHistory(params: HistoryParams): Promise<HaState[][]> {
		const base = params.startTime
			? `/api/history/period/${encodeURIComponent(params.startTime)}`
			: "/api/history/period";
		const query: HaRequestOptions["query"] = {
			filter_entity_id: params.entityIds.join(","),
			end_time: params.endTime,
			minimal_response: params.minimalResponse ? "true" : undefined,
			significant_changes_only: params.significantChangesOnly ? "true" : undefined
		};
		return request<HaState[][]>(base, { query });
	}

	function getLogbook(params: LogbookParams): Promise<HaLogbookEntry[]> {
		const base = params.startTime
			? `/api/logbook/${encodeURIComponent(params.startTime)}`
			: "/api/logbook";
		const query: HaRequestOptions["query"] = {
			end_time: params.endTime,
			entity: params.entityId
		};
		return request<HaLogbookEntry[]>(base, { query });
	}

	return {
		request,
		ping: () => request<HaApiStatus>("/api/"),
		getConfig: () => request<HaConfig>("/api/config"),
		getStates: () => request<HaState[]>("/api/states"),
		getState: (entityId) => request<HaState>(`/api/states/${encodeURIComponent(entityId)}`),
		getServices: () => request<HaServiceDomain[]>("/api/services"),
		callService,
		renderTemplate,
		checkConfig: () =>
			request<HaCheckConfigResult>("/api/config/core/check_config", { method: "POST" }),
		getErrorLog: () => request<string>("/api/error_log", { expect: "text" }),
		startStateWatch: () =>
			Promise.reject(
				new HaApiError("Live state watches go through Vome; on a direct connection, read states instead.", 501, "")
			),
		getCameraImage: (entityId, width) =>
			request<HaImage>(`/api/camera_proxy/${encodeURIComponent(entityId)}`, {
				expect: "binary",
				query: { width }
			}),
		getSupervisorLog: (target, addonSlug) =>
			request<string>(
				target === "addon"
					? `/api/hassio/addons/${encodeURIComponent(addonSlug ?? "")}/logs`
					: `/api/hassio/${encodeURIComponent(target)}/logs`,
				{ expect: "text" }
			),
		getLogbook,
		getHistory,
		fireEvent: (eventType, data) =>
			request<{ message: string }>(`/api/events/${encodeURIComponent(eventType)}`, {
				method: "POST",
				body: data ?? {}
			}),
		getAutomationConfig: (automationId) =>
			request<Record<string, unknown>>(
				`/api/config/automation/config/${encodeURIComponent(automationId)}`
			),
		upsertAutomationConfig: (automationId, automationConfig) => {
			if (!isPlainObject(automationConfig)) {
				throw new HaApiError("Automation config must be a JSON object.", 0, "");
			}
			return request<{ result: string }>(
				`/api/config/automation/config/${encodeURIComponent(automationId)}`,
				{ method: "POST", body: automationConfig }
			);
		},
		deleteAutomationConfig: (automationId) =>
			request<{ result: string }>(
				`/api/config/automation/config/${encodeURIComponent(automationId)}`,
				{ method: "DELETE" }
			),
		getScriptConfig: (scriptId) =>
			request<Record<string, unknown>>(`/api/config/script/config/${encodeURIComponent(scriptId)}`),
		upsertScriptConfig: (scriptId, scriptConfig) => {
			if (!isPlainObject(scriptConfig)) {
				throw new HaApiError("Script config must be a JSON object.", 0, "");
			}
			return request<{ result: string }>(`/api/config/script/config/${encodeURIComponent(scriptId)}`, {
				method: "POST",
				body: scriptConfig
			});
		},
		deleteScriptConfig: (scriptId) =>
			request<{ result: string }>(`/api/config/script/config/${encodeURIComponent(scriptId)}`, {
				method: "DELETE"
			}),
		sendWsCommand: (command) => {
			if (!wsClient) {
				return Promise.reject(
					new HaApiError("WebSocket client is not available.", 0, "")
				);
			}
			return wsClient.sendCommand(command);
		}
	};
}

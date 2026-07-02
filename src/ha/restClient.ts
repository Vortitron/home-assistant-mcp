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

/**
 * Thrown for any non-2xx Home Assistant REST response. Carries the HTTP status
 * and raw body so tools can surface a useful message back to the agent.
 */
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

export interface HaRequestOptions {
	method?: string;
	body?: unknown;
	expect?: "json" | "text";
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
	): Promise<HaState[]>;
	renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string>;
	checkConfig(): Promise<HaCheckConfigResult>;
	getErrorLog(): Promise<string>;
	getLogbook(params: LogbookParams): Promise<HaLogbookEntry[]>;
	getHistory(params: HistoryParams): Promise<HaState[][]>;
	fireEvent(eventType: string, data?: Record<string, unknown>): Promise<{ message: string }>;
	getAutomationConfig(automationId: string): Promise<Record<string, unknown>>;
	upsertAutomationConfig(
		automationId: string,
		config: Record<string, unknown>
	): Promise<{ result: string }>;
	deleteAutomationConfig(automationId: string): Promise<{ result: string }>;
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

export function createHaRestClient(config: Config, logger: Logger): HaRestClient {
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

	function callService(
		domain: string,
		service: string,
		data: Record<string, unknown> = {},
		target?: HaTarget
	): Promise<HaState[]> {
		const body: Record<string, unknown> = { ...data };
		if (target) {
			for (const [key, value] of Object.entries(target)) {
				if (value !== undefined) {
					body[key] = value;
				}
			}
		}
		return request<HaState[]>(
			`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
			{
				method: "POST",
				body
			}
		);
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
			)
	};
}

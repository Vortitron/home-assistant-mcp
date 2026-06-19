import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { HaApiError } from "./restClient.js";
import type { HaRestClient } from "./restClient.js";
import type { HaWsClient } from "./wsClient.js";
import type {
	HaApiStatus,
	HaCheckConfigResult,
	HaConfig,
	HaServiceDomain,
	HaState,
	HaTarget
} from "./types.js";

/**
 * Home Assistant REST client that talks to a VomeHome instance *through* the
 * portal's brokered endpoints (`/api/v1/instances/<id>/ha/*`) instead of
 * directly to Home Assistant.
 *
 * The whole point: the agent holds only a revocable, scoped VomeHome token —
 * never the HA token. The portal keeps the HA credential server-side and
 * enforces the read-only / deny-domain / audit policy there, so it cannot be
 * bypassed. This client therefore exposes the subset of the HA surface the
 * broker proxies — states, services, config, templates, automation config
 * (read with `ha:read`, write with `ha:config`) and check_config; everything
 * else throws a clear "not available in brokered mode" error rather than
 * failing obscurely.
 */

interface BrokerRequestOptions {
	method?: string;
	body?: unknown;
	expect?: "json" | "text";
}

function unsupportedError(feature: string): HaApiError {
	return new HaApiError(
		`'${feature}' is not available in VomeHome brokered mode. The broker exposes ` +
			`list/get entities, services, call_service, config, templates, automation ` +
			`config and check_config. For the full tool surface (registry, logs, history, ` +
			`ESPHome), run with a direct HA_URL + HA_TOKEN instead.`,
		0,
		""
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Broker path for an automation's config endpoint. The id is encoded; the
 * portal also validates it server-side before building the HA path. */
function automationConfigPath(automationId: string): string {
	return `/config/automation/config/${encodeURIComponent(automationId)}`;
}

/** Reject (rather than throw synchronously) so callers using the Promise API
 * get a normal rejection. */
function rejectUnsupported<T>(feature: string): Promise<T> {
	return Promise.reject(unsupportedError(feature));
}

export function createBrokeredHaRestClient(
	config: Config,
	logger: Logger,
	instanceId: string = config.vomehome.instanceId
): HaRestClient {
	const base = `${config.vomehome.apiUrl}/api/v1/instances/${encodeURIComponent(instanceId)}/ha`;

	async function broker<T>(path: string, options: BrokerRequestOptions = {}): Promise<T> {
		const method = options.method ?? "GET";
		const url = `${base}${path}`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
		logger.debug(`VomeHome broker ${method} ${path}`);
		try {
			const response = await fetch(url, {
				method,
				headers: {
					Authorization: `Bearer ${config.vomehome.token}`,
					"Content-Type": "application/json"
				},
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: controller.signal
			});
			const text = await response.text();
			if (!response.ok) {
				throw new HaApiError(brokerErrorMessage(method, path, response.status, text), response.status, text);
			}
			if ((options.expect ?? "json") === "text") {
				return text as unknown as T;
			}
			return (text.length > 0 ? JSON.parse(text) : undefined) as T;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new HaApiError(
					`VomeHome broker ${method} ${path} timed out after ${config.timeoutMs}ms`,
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
		return broker<HaState[]>(
			`/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
			{ method: "POST", body }
		);
	}

	function renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string> {
		const body: Record<string, unknown> = { template };
		if (variables && Object.keys(variables).length > 0) {
			body.variables = variables;
		}
		return broker<string>("/template", { method: "POST", body, expect: "text" });
	}

	return {
		request: () => rejectUnsupported("raw request"),
		ping: () => broker<HaApiStatus>("/"),
		getConfig: () => broker<HaConfig>("/config"),
		getStates: () => broker<HaState[]>("/states"),
		getState: (entityId) => broker<HaState>(`/states/${encodeURIComponent(entityId)}`),
		getServices: () => broker<HaServiceDomain[]>("/services"),
		callService,
		renderTemplate,
		checkConfig: () => broker<HaCheckConfigResult>("/check_config", { method: "POST" }),
		getErrorLog: () => rejectUnsupported("get_error_log"),
		getLogbook: () => rejectUnsupported("get_logbook"),
		getHistory: () => rejectUnsupported("get_history"),
		fireEvent: () => rejectUnsupported("fire_event"),
		getAutomationConfig: (automationId) =>
			broker<Record<string, unknown>>(automationConfigPath(automationId)),
		upsertAutomationConfig: (automationId, automationConfig) => {
			if (!isPlainObject(automationConfig)) {
				return Promise.reject(new HaApiError("Automation config must be a JSON object.", 0, ""));
			}
			return broker<{ result: string }>(automationConfigPath(automationId), {
				method: "POST",
				body: automationConfig
			});
		},
		deleteAutomationConfig: (automationId) =>
			broker<{ result: string }>(automationConfigPath(automationId), { method: "DELETE" })
	};
}

function brokerErrorMessage(method: string, path: string, status: number, body: string): string {
	let detail = body;
	try {
		const parsed = JSON.parse(body) as { error?: string };
		if (parsed && typeof parsed.error === "string") {
			detail = parsed.error;
		}
	} catch {
		// non-JSON body; use raw text
	}
	return `VomeHome broker ${method} ${path} responded ${status}: ${detail}`;
}

/**
 * Stand-in WebSocket client for brokered mode. The portal broker does not
 * expose the area/device/entity registries, so these calls throw a clear
 * message instead of silently failing. (Use `ha_list_entities`, which works
 * over REST, to discover entities in brokered mode.)
 */
export function createUnavailableWsClient(): HaWsClient {
	return {
		sendCommand: () => rejectUnsupported("websocket commands"),
		listAreas: () => rejectUnsupported("list_areas (registry)"),
		listDevices: () => rejectUnsupported("list_devices (registry)"),
		listEntities: () => rejectUnsupported("list_entities (registry)"),
		close: () => Promise.resolve()
	};
}

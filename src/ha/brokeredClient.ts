import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import {
	HaApiError,
	binaryResult,
	refusesReturnResponse,
	serviceTimeoutSeconds,
	STT_TIMEOUT_MS,
	type ServiceCallOptions,
	type SpeechToTextResult,
	type StateWatchGrant
} from "./restClient.js";
import type { HaImage, HaRestClient, HaServiceCallResult, HistoryParams, LogbookParams } from "./restClient.js";
import { commandTimeoutMs, type HaWsClient } from "./wsClient.js";
import { PROBE_TIMEOUT_MS, explainRestart } from "./restart.js";
import type {
	HaApiStatus,
	HaArea,
	HaCheckConfigResult,
	HaConfig,
	HaDevice,
	HaEntityRegistryEntry,
	HaLogbookEntry,
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
 * (read with `ha:read`, write with `ha:config`), Lovelace dashboards,
 * registries (WebSocket), logs/history (Supervisor and add-on logs too), events
 * and check_config; everything
 * else throws a clear "not available in brokered mode" error rather than
 * failing obscurely.
 */

interface BrokerRequestOptions {
	method?: string;
	body?: unknown;
	expect?: "json" | "text" | "binary";
	/** Overrides config.timeoutMs for a call known to run longer. */
	timeoutMs?: number;
}

function unsupportedError(feature: string): HaApiError {
	return new HaApiError(
		`'${feature}' is not available in VomeHome brokered mode. The broker exposes ` +
			`list/get entities, services, call_service, config, templates, automation ` +
			`config, Lovelace dashboard commands, registries, logs, history, events ` +
			`and check_config. For ESPHome, run with a direct HA_URL + HA_TOKEN instead.`,
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

function scriptConfigPath(scriptId: string): string {
	return `/config/script/config/${encodeURIComponent(scriptId)}`;
}

/** Reject (rather than throw synchronously) so callers using the Promise API
 * get a normal rejection. */
function rejectUnsupported<T>(feature: string): Promise<T> {
	return Promise.reject(unsupportedError(feature));
}

function buildQuery(params: Record<string, string | undefined>): string {
	const parts = Object.entries(params)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value as string)}`);
	return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function createBrokeredHaRestClient(
	config: Config,
	logger: Logger,
	instanceId: string = config.vomehome.instanceId
): HaRestClient {
	const base = `${config.vomehome.apiUrl}/api/v1/instances/${encodeURIComponent(instanceId)}/ha`;

	/**
	 * A broker call whose failure, if it looks like the home restarting, is
	 * checked once against the home's /api/config and explained (see
	 * ha/restart.ts). Network errors reaching Vome itself are left alone.
	 */
	async function broker<T>(path: string, options: BrokerRequestOptions = {}): Promise<T> {
		try {
			return await rawBroker<T>(path, options);
		} catch (error) {
			const probe = path === "/config" ? null : () => rawBroker<HaConfig>("/config", { timeoutMs: PROBE_TIMEOUT_MS });
			throw await explainRestart(error, probe);
		}
	}

	async function rawBroker<T>(path: string, options: BrokerRequestOptions = {}): Promise<T> {
		const method = options.method ?? "GET";
		const url = `${base}${path}`;
		const controller = new AbortController();
		const timeoutMs = options.timeoutMs ?? config.timeoutMs;
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
			if (options.expect === "binary" && response.ok) {
				const bytes = Buffer.from(await response.arrayBuffer());
				return binaryResult(bytes, response.headers.get("content-type")) as unknown as T;
			}
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
					`VomeHome broker ${method} ${path} timed out after ${timeoutMs}ms`,
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
		target?: HaTarget,
		options?: ServiceCallOptions
	): Promise<HaServiceCallResult> {
		const seconds = serviceTimeoutSeconds(options);
		const body: Record<string, unknown> = { ...data };
		if (target) {
			for (const [key, value] of Object.entries(target)) {
				if (value !== undefined) {
					body[key] = value;
				}
			}
		}
		// The broker retries with ?return_response itself when HA asks for it,
		// so this can be either shape.
		// A longer wait is asked of the portal (?timeout=, which it carries to
		// the home), and this side waits a few seconds past it so the home's own
		// answer, even a timeout error, gets back.
		// ?return_response asks the portal to pass the same flag to the home, for
		// a service whose response is optional (shell_command). A portal from
		// before it forwarded the flag ignores it, and the call works as before.
		const path = `/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
		const init = { method: "POST", body, ...(seconds === undefined ? {} : { timeoutMs: (seconds + 8) * 1000 }) };
		const timeout = seconds === undefined ? undefined : String(seconds);
		if (options?.returnResponse) {
			try {
				return await broker<HaServiceCallResult>(
					`${path}${buildQuery({ timeout, return_response: "1" })}`,
					init
				);
			} catch (error) {
				if (!refusesReturnResponse(error)) {
					throw error;
				}
			}
		}
		return broker<HaServiceCallResult>(`${path}${buildQuery({ timeout })}`, init);
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
		// The portal reads the WAV, sends the home the bare PCM with
		// X-Speech-Content over its Vome link, and answers with HA's JSON.
		speechToText: (entityId, wavBase64, language) =>
			broker<SpeechToTextResult>(`/stt/${encodeURIComponent(entityId)}`, {
				method: "POST",
				body: { audio_base64: wavBase64, language },
				timeoutMs: STT_TIMEOUT_MS
			}),
		getErrorLog: () => broker<string>("/error_log", { expect: "text" }),
		startStateWatch: (entityIds, jobId) =>
			broker<StateWatchGrant>("/watch", { method: "POST", body: { entity_ids: entityIds, ...(jobId ? { job_id: jobId } : {}) } }),
		getCameraImage: (entityId, width) =>
			broker<HaImage>(
				`/camera_proxy/${encodeURIComponent(entityId)}${buildQuery({ width: width === undefined ? undefined : String(width) })}`,
				{ expect: "binary" }
			),
		getSupervisorLog: (target, addonSlug) =>
			broker<string>(
				target === "addon"
					? `/supervisor/logs/addon/${encodeURIComponent(addonSlug ?? "")}`
					: `/supervisor/logs/${encodeURIComponent(target)}`,
				{ expect: "text" }
			),
		getLogbook: (params: LogbookParams) => {
			const base = params.startTime
				? `/logbook/${encodeURIComponent(params.startTime)}`
				: "/logbook";
			const query = buildQuery({
				end_time: params.endTime,
				entity: params.entityId
			});
			return broker<HaLogbookEntry[]>(`${base}${query}`);
		},
		getHistory: (params: HistoryParams) => {
			const base = params.startTime
				? `/history/period/${encodeURIComponent(params.startTime)}`
				: "/history/period";
			const query = buildQuery({
				filter_entity_id: params.entityIds.join(","),
				end_time: params.endTime,
				minimal_response: params.minimalResponse ? "true" : undefined,
				significant_changes_only: params.significantChangesOnly ? "true" : undefined
			});
			return broker<HaState[][]>(`${base}${query}`);
		},
		fireEvent: (eventType: string, data?: Record<string, unknown>) =>
			broker<{ message: string }>(`/events/${encodeURIComponent(eventType)}`, {
				method: "POST",
				body: data ?? {}
			}),
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
			broker<{ result: string }>(automationConfigPath(automationId), { method: "DELETE" }),
		getScriptConfig: (scriptId) => broker<Record<string, unknown>>(scriptConfigPath(scriptId)),
		upsertScriptConfig: (scriptId, scriptConfig) => {
			if (!isPlainObject(scriptConfig)) {
				return Promise.reject(new HaApiError("Script config must be a JSON object.", 0, ""));
			}
			return broker<{ result: string }>(scriptConfigPath(scriptId), { method: "POST", body: scriptConfig });
		},
		deleteScriptConfig: (scriptId) => broker<{ result: string }>(scriptConfigPath(scriptId), { method: "DELETE" }),
		sendWsCommand: <T = unknown>(command: Record<string, unknown>) => {
			if (!isPlainObject(command) || typeof command.type !== "string") {
				return Promise.reject(
					new HaApiError("WebSocket command must be an object with a type field.", 0, "")
				);
			}
			return broker<{ result: T }>("/ws/command", {
				method: "POST",
				body: command,
				timeoutMs: commandTimeoutMs(command, config.timeoutMs)
			}).then((envelope) => envelope.result);
		}
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
 * WebSocket stand-in for brokered mode — registry and Lovelace commands route
 * through the portal's ``/ha/ws/command`` endpoint via the REST client.
 */
export function createBrokeredWsClient(getRest: () => HaRestClient): HaWsClient {
	const send = <T = unknown>(command: Record<string, unknown>) => getRest().sendWsCommand<T>(command);
	return {
		sendCommand: send,
		listAreas: () => send<HaArea[]>({ type: "config/area_registry/list" }),
		listDevices: () => send<HaDevice[]>({ type: "config/device_registry/list" }),
		listEntities: () => send<HaEntityRegistryEntry[]>({ type: "config/entity_registry/list" }),
		close: () => Promise.resolve()
	};
}

/** @deprecated Use {@link createBrokeredWsClient} — registries are brokered now. */
export function createUnavailableWsClient(): HaWsClient {
	return {
		sendCommand: () => rejectUnsupported("websocket commands"),
		listAreas: () => rejectUnsupported("list_areas (registry)"),
		listDevices: () => rejectUnsupported("list_devices (registry)"),
		listEntities: () => rejectUnsupported("list_entities (registry)"),
		close: () => Promise.resolve()
	};
}

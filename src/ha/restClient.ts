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
import { PROBE_TIMEOUT_MS, explainRestart } from "./restart.js";
import { parseWav, speechContentHeader } from "./wav.js";

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

/**
 * HA's 400 for a service called with ?return_response that returns nothing
 * ("An action which does not return responses can't be called with
 * return_response=True"; before 2024.x "Service does not support responses").
 */
export function refusesReturnResponse(error: unknown): boolean {
	return (
		error instanceof HaApiError &&
		error.status === 400 &&
		/does not (?:support|return) responses|remove return_response/i.test(error.body)
	);
}

/** HA's 400 for a service that only works with ?return_response. */
export function wantsReturnResponse(error: unknown): boolean {
	return (
		error instanceof HaApiError &&
		error.status === 400 &&
		/return_response/.test(error.body) &&
		!refusesReturnResponse(error)
	);
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

/**
 * A call that failed because Home Assistant is restarting (or not answering
 * the way it does while it restarts), with the failure explained. See
 * `ha/restart.ts`. Status 503 so code that treats a 404 as "no such thing"
 * does not mistake a restart's nginx 404 page for an answer.
 */
export class HaRestartingError extends HaApiError {
	/** Core state Home Assistant reported (e.g. "STARTING"), or null when it did not answer at all. */
	readonly coreState: string | null;
	/** The original failure, briefly, for debugging. */
	readonly original: string;

	constructor(message: string, coreState: string | null, original: string) {
		super(message, 503, "");
		this.name = "HaRestartingError";
		this.coreState = coreState;
		this.original = original;
	}
}

/**
 * A call to a CHAP pair's main install failed restart-shaped because the
 * standby is running the home (the main is stopped on purpose): see
 * vomehome/failover.ts. A {@link HaRestartingError} still, so everything that
 * treats "not answering" specially keeps doing so; its message names the
 * standby to use instead.
 */
export class HaFailoverError extends HaRestartingError {
	readonly standbyId: string;
	readonly standbyName: string;

	constructor(message: string, standbyId: string, standbyName: string, original: string) {
		super(message, null, original);
		this.name = "HaFailoverError";
		this.standbyId = standbyId;
		this.standbyName = standbyName;
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
	/** Bytes sent as they are, in place of a JSON `body` (speech to text's bare PCM). */
	rawBody?: Uint8Array;
	/** Extra request headers; a Content-Type here replaces the JSON one. */
	headers?: Record<string, string>;
	/** "binary" resolves to an {@link HaImage} rather than parsed text. */
	expect?: "json" | "text" | "binary";
	query?: Record<string, string | number | boolean | undefined>;
	/** Overrides config.timeoutMs for a call known to run longer. */
	timeoutMs?: number;
}

/** Per-call options for a service call. */
export interface ServiceCallOptions {
	/**
	 * How long to wait for the service to answer, in seconds. For actions that
	 * take a while (ai_task.generate_data with an image, a script that waits).
	 * At most {@link SERVICE_MAX_TIMEOUT_SECONDS}: the public proxy in front of
	 * the portal ends a request at 60 s.
	 */
	timeoutSeconds?: number;
	/**
	 * Ask for the service's own response (?return_response). For a service
	 * whose response is optional (shell_command's stdout and returncode,
	 * script, weather.get_forecasts …) Home Assistant only sends it when asked.
	 * A service that turns out not to return one is called again without.
	 */
	returnResponse?: boolean;
}

export const SERVICE_MAX_TIMEOUT_SECONDS = 50;

/** What Home Assistant's /api/stt/<entity> answers: the words, and "success" or "error". */
export interface SpeechToTextResult {
	text: string | null;
	result: string;
	[key: string]: unknown;
}

/** How long one speech-to-text request may take: the engine may be a cloud one, and the portal allows the home 40 s. */
export const STT_TIMEOUT_MS = 45_000;

export function serviceTimeoutSeconds(options?: ServiceCallOptions): number | undefined {
	const asked = options?.timeoutSeconds;
	if (asked === undefined || !Number.isFinite(asked) || asked <= 0) {
		return undefined;
	}
	return Math.min(Math.ceil(asked), SERVICE_MAX_TIMEOUT_SECONDS);
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
		target?: HaTarget,
		options?: ServiceCallOptions
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
	/**
	 * A 16-bit PCM WAV (base64) through a speech-to-text engine (`stt.*`).
	 * Direct: the bare PCM to /api/stt/<entity> with X-Speech-Content. Brokered:
	 * the WAV to the portal, which does the same over the home's Vome link.
	 */
	speechToText(entityId: string, wavBase64: string, language: string): Promise<SpeechToTextResult>;
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
	/**
	 * A request whose failure, if it looks like a restart, is checked once
	 * against /api/config and explained (see ha/restart.ts).
	 */
	async function request<T>(path: string, options: HaRequestOptions = {}): Promise<T> {
		try {
			return await rawRequest<T>(path, options);
		} catch (error) {
			const probe =
				path === "/api/config" ? null : () => rawRequest<HaConfig>("/api/config", { timeoutMs: PROBE_TIMEOUT_MS });
			throw await explainRestart(error, probe, { network: true });
		}
	}

	async function rawRequest<T>(path: string, options: HaRequestOptions = {}): Promise<T> {
		const method = options.method ?? "GET";
		const url = `${config.haUrl}${path}${buildQuery(options.query)}`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.timeoutMs);
		logger.debug(`HA ${method} ${path}`);
		try {
			const response = await fetch(url, {
				method,
				headers: {
					Authorization: `Bearer ${config.haToken}`,
					"Content-Type": "application/json",
					...options.headers
				},
				body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
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
					`Home Assistant ${method} ${path} timed out after ${options.timeoutMs ?? config.timeoutMs}ms`,
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
		const timeoutMs = seconds === undefined ? undefined : seconds * 1000;
		const body: Record<string, unknown> = { ...data };
		if (target) {
			for (const [key, value] of Object.entries(target)) {
				if (value !== undefined) {
					body[key] = value;
				}
			}
		}
		const path = `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
		if (options?.returnResponse) {
			try {
				return await request<HaServiceCallResult>(path, {
					method: "POST",
					body,
					query: { return_response: "true" },
					timeoutMs
				});
			} catch (error) {
				// Asked of a service that returns nothing: call it the plain way.
				if (!refusesReturnResponse(error)) {
					throw error;
				}
			}
		}
		try {
			return await request<HaServiceCallResult>(path, { method: "POST", body, timeoutMs });
		} catch (error) {
			// Services that return data (vomesync.subscribe_switch, ...) refuse
			// a plain call. Retry once asking for the response, as the VomeHome
			// broker does, so both transports behave the same.
			if (!wantsReturnResponse(error)) {
				throw error;
			}
			return request<HaServiceCallResult>(path, {
				method: "POST",
				body,
				query: { return_response: "true" },
				timeoutMs
			});
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

	/**
	 * Home Assistant's SpeechToTextView reads the body as a stream of audio
	 * and every detail of it from X-Speech-Content (all six fields are
	 * required); it does not look at Content-Type. So the WAV's header is
	 * stripped here and what it said goes in that header, as a satellite does.
	 */
	function speechToText(entityId: string, wavBase64: string, language: string): Promise<SpeechToTextResult> {
		const wav = Buffer.from(wavBase64, "base64");
		const info = parseWav(wav);
		if (!info.ok) {
			return Promise.reject(new HaApiError(info.message, 400, ""));
		}
		return request<SpeechToTextResult>(`/api/stt/${encodeURIComponent(entityId)}`, {
			method: "POST",
			rawBody: wav.subarray(info.dataOffset, info.dataOffset + info.dataLength),
			headers: {
				"Content-Type": "audio/wav",
				"X-Speech-Content": speechContentHeader(info, language)
			},
			timeoutMs: STT_TIMEOUT_MS
		});
	}

	return {
		request,
		speechToText,
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

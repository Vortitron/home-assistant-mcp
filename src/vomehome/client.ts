import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

/**
 * Client for the VomeHome portal API (managed Home Assistant hosting).
 *
 * It speaks the portal's token-authenticated JSON API under `/api/v1/instances`,
 * authenticating with a personal access token (PAT) that the user mints in the
 * portal after logging in with GitHub. The PAT is sent as a bearer token.
 *
 * The endpoints intentionally mirror what the portal already does from its web
 * UI (list servers, reboot, create, one-click HA login) so that an agent can
 * perform the same "basic" operations from the editor while advanced management
 * stays behind a full browser login on the portal.
 */

const INSTANCES_PATH = "/api/v1/instances";

export interface VomeHomeLiveStatus {
	reachable?: boolean;
	haState?: string;
	haHealth?: string;
}

export interface VomeHomeInstance {
	id: string;
	name?: string;
	status?: string;
	tier?: string;
	haUrl?: string;
	customDomain?: string;
	createdAt?: string;
	live?: VomeHomeLiveStatus;
}

export interface VomeHomeActionResult {
	success: boolean;
	message?: string;
}

export interface VomeHomeLoginUrl {
	url: string;
	expiresAt?: string;
}

export interface CreateInstanceInput {
	name: string;
	timezone?: string;
}

export interface CreatedVomeHomeInstance extends VomeHomeInstance {
	/** Per-instance HA scopes the portal granted this API key on create. */
	grantedScopes?: string[];
}

export interface CreateGuestLinkInput {
	/** Non-admin unless true. Admin grants full control — choose deliberately. */
	admin?: boolean;
	/** Lovelace url_path to land on after sign-in, instead of the default dashboard. */
	dashboard?: string;
	/** Seconds until the guest link is auto-revoked. Portal default 24h, capped at 30 days. */
	expiresIn?: number;
}

export interface GuestLink {
	id: string;
	url: string;
	expiresAt?: number;
}

export interface GuestLinkSummary {
	id: string;
	admin: boolean;
	dashboard?: string;
	createdAt?: number;
	expiresAt?: number;
	revokedAt?: number;
}

export interface VomeHomeClient {
	isEnabled(): boolean;
	listInstances(): Promise<VomeHomeInstance[]>;
	getInstance(id: string): Promise<VomeHomeInstance>;
	restartInstance(id: string): Promise<VomeHomeActionResult>;
	createInstance(input: CreateInstanceInput): Promise<CreatedVomeHomeInstance>;
	getLoginUrl(id: string): Promise<VomeHomeLoginUrl>;
	createGuestLink(id: string, input: CreateGuestLinkInput): Promise<GuestLink>;
	listGuestLinks(id: string): Promise<GuestLinkSummary[]>;
	revokeGuestLink(id: string, linkId: string): Promise<void>;
	getOnboarding(id: string): Promise<OnboardingState>;
	completeOnboarding(id: string, coreConfig?: Record<string, unknown>): Promise<OnboardingResult>;
}

/** Which Home Assistant setup-wizard steps are still outstanding. */
export interface OnboardingState {
	onboarded: boolean;
	steps: { step: string; done: boolean }[];
}

/** What finishing the wizard actually did. */
export interface OnboardingResult {
	completed: string[];
	alreadyDone: string[];
	coreConfigApplied: boolean;
	steps: { step: string; done: boolean }[];
}

/** Thrown for any non-2xx VomeHome portal response (or a timeout). */
export class VomeHomeError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(message: string, status = 0, body = "") {
		super(message);
		this.name = "VomeHomeError";
		this.status = status;
		this.body = body;
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const out = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return out.length > 0 ? out : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalises one instance object from the portal into our camelCase shape,
 * tolerating either snake_case (the portal's convention) or camelCase keys so
 * the client is resilient to minor API differences.
 */
export function normaliseInstance(raw: unknown): VomeHomeInstance {
	if (!isRecord(raw)) {
		throw new VomeHomeError("VomeHome API returned a non-object instance.");
	}
	const id = asString(raw.id);
	if (!id) {
		throw new VomeHomeError("VomeHome API returned an instance without an id.");
	}
	const liveRaw = isRecord(raw.live) ? raw.live : undefined;
	const live: VomeHomeLiveStatus | undefined = liveRaw
		? {
				reachable: asBoolean(liveRaw.reachable),
				haState: asString(liveRaw.ha_state) ?? asString(liveRaw.haState),
				haHealth: asString(liveRaw.ha_health) ?? asString(liveRaw.haHealth)
			}
		: undefined;
	return {
		id,
		name: asString(raw.name),
		status: asString(raw.status),
		tier: asString(raw.tier),
		haUrl: asString(raw.ha_url) ?? asString(raw.haUrl),
		customDomain: asString(raw.custom_domain) ?? asString(raw.customDomain),
		createdAt: asString(raw.created_at) ?? asString(raw.createdAt),
		live
	};
}

export function createVomeHomeClient(config: Config, logger: Logger): VomeHomeClient {
	const { apiUrl, token } = config.vomehome;

	function assertEnabled(): void {
		if (!config.vomehome.enabled) {
			throw new VomeHomeError(
				"VomeHome is not configured. Set VOMEHOME_TOKEN (mint one in the VomeHome portal under Account -> API tokens) to enable VomeHome tools."
			);
		}
	}

	async function request<T>(
		path: string,
		options: { method?: string; body?: unknown } = {}
	): Promise<T> {
		assertEnabled();
		const method = options.method ?? "GET";
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), config.timeoutMs);
		logger.debug(`VomeHome ${method} ${path}`);
		try {
			const response = await fetch(`${apiUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					...(options.body !== undefined ? { "Content-Type": "application/json" } : {})
				},
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: controller.signal
			});
			const text = await response.text();
			if (!response.ok) {
				throw new VomeHomeError(
					`VomeHome ${method} ${path} responded ${response.status} ${response.statusText}`,
					response.status,
					text
				);
			}
			return (text.length > 0 ? JSON.parse(text) : undefined) as T;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new VomeHomeError(
					`VomeHome ${method} ${path} timed out after ${config.timeoutMs}ms`
				);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	async function listInstances(): Promise<VomeHomeInstance[]> {
		const payload = await request<{ instances?: unknown }>(INSTANCES_PATH);
		const list = Array.isArray(payload?.instances) ? payload.instances : [];
		return list.map(normaliseInstance);
	}

	async function getInstance(id: string): Promise<VomeHomeInstance> {
		const payload = await request<{ instance?: unknown }>(
			`${INSTANCES_PATH}/${encodeURIComponent(id)}`
		);
		return normaliseInstance(payload?.instance);
	}

	async function restartInstance(id: string): Promise<VomeHomeActionResult> {
		const payload = await request<{ success?: unknown; message?: unknown }>(
			`${INSTANCES_PATH}/${encodeURIComponent(id)}/restart`,
			{ method: "POST", body: {} }
		);
		return {
			success: asBoolean(payload?.success) ?? true,
			message: asString(payload?.message)
		};
	}

	async function createInstance(input: CreateInstanceInput): Promise<CreatedVomeHomeInstance> {
		const body: Record<string, unknown> = { name: input.name };
		if (input.timezone) {
			body.timezone = input.timezone;
		}
		const payload = await request<{ instance?: unknown }>(INSTANCES_PATH, {
			method: "POST",
			body
		});
		const instance = normaliseInstance(payload?.instance);
		const grantedScopes = isRecord(payload?.instance)
			? asStringList(payload.instance.granted_scopes)
			: undefined;
		return grantedScopes ? { ...instance, grantedScopes } : instance;
	}

	async function getLoginUrl(id: string): Promise<VomeHomeLoginUrl> {
		const payload = await request<{ url?: unknown; expires_at?: unknown; expiresAt?: unknown }>(
			`${INSTANCES_PATH}/${encodeURIComponent(id)}/login-url`
		);
		const url = asString(payload?.url);
		if (!url) {
			throw new VomeHomeError("VomeHome login-url response did not contain a url.");
		}
		return {
			url,
			expiresAt: asString(payload?.expires_at) ?? asString(payload?.expiresAt)
		};
	}

	async function createGuestLink(id: string, input: CreateGuestLinkInput): Promise<GuestLink> {
		const body: Record<string, unknown> = {};
		if (input.admin !== undefined) body.admin = input.admin;
		if (input.dashboard !== undefined) body.dashboard = input.dashboard;
		if (input.expiresIn !== undefined) body.expires_in = input.expiresIn;
		const payload = await request<{ id?: unknown; url?: unknown; expires_at?: unknown }>(
			`${INSTANCES_PATH}/${encodeURIComponent(id)}/guest-links`,
			{ method: "POST", body }
		);
		const url = asString(payload?.url);
		const linkId = asString(payload?.id);
		if (!url || !linkId) {
			throw new VomeHomeError("VomeHome guest-link create response did not contain an id/url.");
		}
		return { id: linkId, url, expiresAt: asNumber(payload?.expires_at) };
	}

	async function getOnboarding(id: string): Promise<OnboardingState> {
		const payload = await request<{ onboarded?: unknown; steps?: unknown }>(
			`${INSTANCES_PATH}/${encodeURIComponent(id)}/onboarding`
		);
		const steps = Array.isArray(payload?.steps) ? payload.steps : [];
		return {
			onboarded: payload?.onboarded === true,
			steps: steps.filter(isRecord).map((row) => ({
				step: String(row.step ?? ""),
				done: row.done === true
			}))
		};
	}

	async function completeOnboarding(
		id: string,
		coreConfig?: Record<string, unknown>
	): Promise<OnboardingResult> {
		const body: Record<string, unknown> = {};
		if (coreConfig !== undefined) body.core_config = coreConfig;
		const payload = await request<{
			completed?: unknown;
			already_done?: unknown;
			core_config_applied?: unknown;
			steps?: unknown;
		}>(`${INSTANCES_PATH}/${encodeURIComponent(id)}/onboarding/complete`, {
			method: "POST",
			body
		});
		const steps = Array.isArray(payload?.steps) ? payload.steps : [];
		return {
			completed: Array.isArray(payload?.completed) ? payload.completed.map(String) : [],
			alreadyDone: Array.isArray(payload?.already_done)
				? payload.already_done.map(String)
				: [],
			coreConfigApplied: payload?.core_config_applied === true,
			steps: steps.filter(isRecord).map((row) => ({
				step: String(row.step ?? ""),
				done: row.done === true
			}))
		};
	}

	async function listGuestLinks(id: string): Promise<GuestLinkSummary[]> {
		const payload = await request<{ guest_links?: unknown }>(
			`${INSTANCES_PATH}/${encodeURIComponent(id)}/guest-links`
		);
		const list = Array.isArray(payload?.guest_links) ? payload.guest_links : [];
		return list.filter(isRecord).map((row) => ({
			id: asString(row.id) ?? "",
			admin: asBoolean(row.admin) ?? false,
			dashboard: asString(row.dashboard),
			createdAt: asNumber(row.created_at),
			expiresAt: asNumber(row.expires_at),
			revokedAt: asNumber(row.revoked_at)
		}));
	}

	async function revokeGuestLink(id: string, linkId: string): Promise<void> {
		await request(
			`${INSTANCES_PATH}/${encodeURIComponent(id)}/guest-links/${encodeURIComponent(linkId)}`,
			{ method: "DELETE" }
		);
	}

	return {
		isEnabled: () => config.vomehome.enabled,
		listInstances,
		getInstance,
		restartInstance,
		createGuestLink,
		getOnboarding,
		completeOnboarding,
		listGuestLinks,
		revokeGuestLink,
		createInstance,
		getLoginUrl
	};
}

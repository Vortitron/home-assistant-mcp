import type { LogLevel } from "./logger.js";

/**
 * Runtime configuration, parsed once from the environment. Nothing here is
 * exported as a mutable singleton; callers receive a fresh object from
 * {@link loadConfig} and pass it down explicitly.
 */

export interface SafetyConfig {
	/** Master write switch. While false every state-changing tool is refused. */
	allowWrite: boolean;
	/** Allow editing automation/script/scene config via the config API. */
	allowConfigWrite: boolean;
	/** Domains that may never be written, even when allowWrite is true. */
	denyDomains: readonly string[];
	/** When non-empty, only these domains may be written. */
	allowDomains: readonly string[];
}

export interface EsphomeConfig {
	dashboardUrl: string;
	token: string;
	username: string;
	password: string;
	/** True when a dashboard URL has been configured. */
	enabled: boolean;
}

export interface VomeHomeConfig {
	/** Base URL of the VomeHome portal, no trailing slash (e.g. https://vome.io). */
	apiUrl: string;
	/** Personal access token minted in the VomeHome portal (Account -> API tokens). */
	token: string;
	/**
	 * Instance (server) id to broker Home Assistant calls to. When set (with a
	 * token, and no direct HA_TOKEN) the HA tools route through VomeHome instead
	 * of talking to Home Assistant directly.
	 */
	instanceId: string;
	/**
	 * Extra guard for the heavyweight "create instance" action. Even with the
	 * master write switch on, creating a VM additionally requires this.
	 */
	allowCreate: boolean;
	/** True when both an API URL and a token are configured. */
	enabled: boolean;
}

export interface Config {
	haUrl: string;
	haToken: string;
	/**
	 * When true, Home Assistant reads/writes are brokered through VomeHome (the
	 * agent never holds an HA token; policy is enforced server-side). Set
	 * automatically when a VomeHome token + instance id are present and no direct
	 * HA_TOKEN is configured.
	 */
	brokered: boolean;
	timeoutMs: number;
	maxResults: number;
	logLevel: LogLevel;
	safety: SafetyConfig;
	esphome: EsphomeConfig;
	vomehome: VomeHomeConfig;
}

export interface ConfigProblem {
	field: string;
	message: string;
}

const DEFAULT_DENY_DOMAINS =
	"lock,alarm_control_panel,cover,climate,vacuum,valve,water_heater,lawn_mower,camera";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 500;
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const DEFAULT_VOMEHOME_API_URL = "https://vome.io";
const VALID_LOG_LEVELS: readonly string[] = ["error", "warn", "info", "debug"];

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value.trim() === "") {
		return fallback;
	}
	return /^(1|true|yes|on)$/i.test(value.trim());
}

function parseDomainList(value: string | undefined, fallback: string): readonly string[] {
	const raw = value === undefined ? fallback : value;
	return raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLogLevel(value: string | undefined): LogLevel {
	const candidate = (value ?? "").trim().toLowerCase();
	return VALID_LOG_LEVELS.includes(candidate) ? (candidate as LogLevel) : DEFAULT_LOG_LEVEL;
}

function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
	const esphomeUrl = stripTrailingSlashes((env.ESPHOME_DASHBOARD_URL ?? "").trim());
	const vomehomeUrl = stripTrailingSlashes(
		(env.VOMEHOME_API_URL ?? DEFAULT_VOMEHOME_API_URL).trim()
	);
	const vomehomeToken = (env.VOMEHOME_TOKEN ?? "").trim();
	const vomehomeInstanceId = (env.VOMEHOME_INSTANCE_ID ?? "").trim();
	const haToken = (env.HA_TOKEN ?? "").trim();
	// Brokered HA mode: the agent has a VomeHome token + instance but no direct
	// HA token, so all HA traffic must go through the (policed, audited) portal.
	const brokered =
		vomehomeToken.length > 0 &&
		vomehomeUrl.length > 0 &&
		vomehomeInstanceId.length > 0 &&
		haToken.length === 0;
	return {
		haUrl: stripTrailingSlashes((env.HA_URL ?? "").trim()),
		haToken,
		brokered,
		timeoutMs: parsePositiveInt(env.HA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
		maxResults: parsePositiveInt(env.MAX_RESULTS, DEFAULT_MAX_RESULTS),
		logLevel: parseLogLevel(env.LOG_LEVEL),
		safety: {
			allowWrite: parseBoolean(env.HA_ALLOW_WRITE, false),
			allowConfigWrite: parseBoolean(env.HA_ALLOW_CONFIG_WRITE, false),
			denyDomains: parseDomainList(env.HA_DENY_DOMAINS, DEFAULT_DENY_DOMAINS),
			allowDomains: parseDomainList(env.HA_ALLOW_DOMAINS, "")
		},
		esphome: {
			dashboardUrl: esphomeUrl,
			token: (env.ESPHOME_DASHBOARD_TOKEN ?? "").trim(),
			username: (env.ESPHOME_DASHBOARD_USERNAME ?? "").trim(),
			password: (env.ESPHOME_DASHBOARD_PASSWORD ?? "").trim(),
			enabled: esphomeUrl.length > 0
		},
		vomehome: {
			apiUrl: vomehomeUrl,
			token: vomehomeToken,
			instanceId: vomehomeInstanceId,
			allowCreate: parseBoolean(env.VOMEHOME_ALLOW_CREATE, false),
			enabled: vomehomeToken.length > 0 && vomehomeUrl.length > 0
		}
	};
}

export function validateConfig(config: Config): ConfigProblem[] {
	const problems: ConfigProblem[] = [];
	// Brokered mode: validate the VomeHome side instead of direct HA creds.
	if (config.brokered) {
		if (!config.vomehome.apiUrl || !/^https?:\/\//i.test(config.vomehome.apiUrl)) {
			problems.push({
				field: "VOMEHOME_API_URL",
				message: "VOMEHOME_API_URL must start with http:// or https:// (e.g. https://vome.io)."
			});
		}
		if (!config.vomehome.token) {
			problems.push({ field: "VOMEHOME_TOKEN", message: "VOMEHOME_TOKEN is required for brokered mode." });
		}
		if (!config.vomehome.instanceId) {
			problems.push({
				field: "VOMEHOME_INSTANCE_ID",
				message: "VOMEHOME_INSTANCE_ID is required for brokered mode (the instance to control)."
			});
		}
		return problems;
	}
	if (!config.haUrl) {
		problems.push({
			field: "HA_URL",
			message: "HA_URL is required (e.g. http://homeassistant.local:8123). Or use brokered mode: set VOMEHOME_TOKEN + VOMEHOME_INSTANCE_ID and leave HA_TOKEN empty."
		});
	} else if (!/^https?:\/\//i.test(config.haUrl)) {
		problems.push({ field: "HA_URL", message: "HA_URL must start with http:// or https://." });
	}
	if (!config.haToken) {
		problems.push({
			field: "HA_TOKEN",
			message: "HA_TOKEN is required (a Home Assistant long-lived access token). Or use brokered mode via VomeHome (VOMEHOME_TOKEN + VOMEHOME_INSTANCE_ID)."
		});
	}
	return problems;
}

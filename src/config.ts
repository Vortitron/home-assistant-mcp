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

export interface Config {
	haUrl: string;
	haToken: string;
	timeoutMs: number;
	maxResults: number;
	logLevel: LogLevel;
	safety: SafetyConfig;
	esphome: EsphomeConfig;
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
	return {
		haUrl: stripTrailingSlashes((env.HA_URL ?? "").trim()),
		haToken: (env.HA_TOKEN ?? "").trim(),
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
		}
	};
}

export function validateConfig(config: Config): ConfigProblem[] {
	const problems: ConfigProblem[] = [];
	if (!config.haUrl) {
		problems.push({
			field: "HA_URL",
			message: "HA_URL is required (e.g. http://homeassistant.local:8123)."
		});
	} else if (!/^https?:\/\//i.test(config.haUrl)) {
		problems.push({ field: "HA_URL", message: "HA_URL must start with http:// or https://." });
	}
	if (!config.haToken) {
		problems.push({
			field: "HA_TOKEN",
			message: "HA_TOKEN is required (a Home Assistant long-lived access token)."
		});
	}
	return problems;
}

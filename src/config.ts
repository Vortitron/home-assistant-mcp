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
	/** True when ESPHome tools are available (direct dashboard URL or brokered). */
	enabled: boolean;
	/**
	 * True when ESPHome is reached through the VomeHome relay broker rather than a
	 * direct dashboard URL. The REST subset (list/version/read+write YAML) is
	 * brokered; streaming build commands need a direct ESPHOME_DASHBOARD_URL.
	 */
	brokered: boolean;
}

export interface NodeRedConfig {
	/** Base URL of the Node-RED editor/admin API, no trailing slash. */
	url: string;
	/** Bearer access token for the admin API, if adminAuth is enabled. */
	token: string;
	/** Username for adminAuth password grant (used to obtain a token). */
	username: string;
	/** Password for adminAuth password grant. */
	password: string;
	/** True when a Node-RED admin URL is configured (tools are then exposed). */
	enabled: boolean;
}

/**
 * Per-instance access entry. WRITE and CONFIG_WRITE are scoped to ONE specific
 * VomeHome instance.
 *
 * In brokered mode these are *client-side, optional* guards: the VomeHome
 * portal is the real authority and enforces what the API key may do per
 * instance (read / write / config / create), so the MCP defaults to permissive
 * and lets the server decide. Setting a flag to false here only adds a local
 * belt-and-braces restriction on top of the server's policy.
 */
export interface InstanceAccess {
	/** VomeHome instance (server) id this entry applies to. */
	id: string;
	/** Allow state-changing HA writes (services, fire_event) on THIS instance. */
	write: boolean;
	/** Allow editing automation/script/scene config on THIS instance. */
	config: boolean;
	/** Optional human label, for logs and tool output. */
	label?: string;
	/**
	 * True when this entry was auto-granted because the instance was created via
	 * the MCP (VOMEHOME_ALLOW_CREATE) rather than declared in the environment.
	 */
	created?: boolean;
}

/**
 * A VOMEHOME_INSTANCES entry as parsed from the environment, before the
 * mode default is applied. `write`/`config` are left undefined when the user
 * did not state them, so brokered mode can default them permissive (server
 * enforces) while still honouring an explicit `false` as a local restriction.
 */
interface RawInstanceAccess {
	id: string;
	write?: boolean;
	config?: boolean;
	label?: string;
}

export interface VomeHomeConfig {
	/** Base URL of the VomeHome portal, no trailing slash (e.g. https://vome.io). */
	apiUrl: string;
	/** Personal access token minted in the VomeHome portal (Account -> API tokens). */
	token: string;
	/**
	 * The active/default instance (server) id to broker Home Assistant calls to.
	 * When set (with a token, and no direct HA_TOKEN) the HA tools route through
	 * VomeHome instead of talking to Home Assistant directly. The active instance
	 * can be switched at runtime (vomehome_use_instance / vomehome_create_instance).
	 */
	instanceId: string;
	/**
	 * Per-instance access registry. Built from VOMEHOME_INSTANCES (JSON) plus the
	 * default instance (VOMEHOME_INSTANCE_ID with HA_ALLOW_WRITE /
	 * HA_ALLOW_CONFIG_WRITE folded in). Each entry's write/config flags apply to
	 * that instance ONLY, and in brokered mode are an optional client-side guard
	 * on top of the server's per-key policy (omitted flags default permissive).
	 */
	instances: InstanceAccess[];
	/** Set when VOMEHOME_INSTANCES was provided but could not be parsed. */
	instancesError?: string;
			/**
			 * Optional local guard for creating instances. In brokered mode this
			 * defaults permissive — the API key's create scope is the real authority.
			 * Set VOMEHOME_ALLOW_CREATE=false to block creation locally regardless.
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
	nodered: NodeRedConfig;
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

/** Coerces a JSON value (boolean or stringy boolean) to a boolean. */
function parseFlag(value: unknown): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return /^(1|true|yes|on)$/i.test(value.trim());
	}
	return false;
}

/** Normalises one raw VOMEHOME_INSTANCES entry into a {@link RawInstanceAccess}. */
function parseInstanceEntry(raw: unknown): RawInstanceAccess | undefined {
	if (typeof raw === "string") {
		const id = raw.trim();
		// A bare id states no flags, so it inherits the mode default.
		return id ? { id } : undefined;
	}
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>;
		const id = typeof obj.id === "string" ? obj.id.trim() : "";
		if (!id) {
			return undefined;
		}
		const entry: RawInstanceAccess = { id };
		// Only pin a flag the caller actually stated; an omitted flag inherits
		// the mode default (permissive in brokered mode — the server decides).
		if ("write" in obj) {
			entry.write = parseFlag(obj.write);
		}
		if ("config" in obj) {
			entry.config = parseFlag(obj.config);
		}
		if (typeof obj.label === "string" && obj.label.trim().length > 0) {
			entry.label = obj.label.trim();
		}
		return entry;
	}
	return undefined;
}

/**
 * Parses VOMEHOME_INSTANCES, which may be a JSON array of ids/objects or a JSON
 * object keyed by id. Returns the de-duplicated list and a parse error (if any)
 * so {@link validateConfig} can surface it rather than failing silently.
 */
function parseInstances(raw: string | undefined): { list: RawInstanceAccess[]; error?: string } {
	const trimmed = (raw ?? "").trim();
	if (trimmed.length === 0) {
		return { list: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		return { list: [], error: `VOMEHOME_INSTANCES is not valid JSON: ${(error as Error).message}` };
	}
	const entries: RawInstanceAccess[] = [];
	if (Array.isArray(parsed)) {
		for (const item of parsed) {
			const entry = parseInstanceEntry(item);
			if (entry) {
				entries.push(entry);
			}
		}
	} else if (parsed !== null && typeof parsed === "object") {
		for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
			const merged =
				value !== null && typeof value === "object" && !Array.isArray(value)
					? { id, ...(value as Record<string, unknown>) }
					: { id };
			const entry = parseInstanceEntry(merged);
			if (entry) {
				entries.push(entry);
			}
		}
	} else {
		return { list: [], error: "VOMEHOME_INSTANCES must be a JSON array or object." };
	}
	// De-duplicate by id (last declaration wins).
	const byId = new Map<string, RawInstanceAccess>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
	}
	return { list: [...byId.values()] };
}

/**
 * Folds the legacy single-instance env (VOMEHOME_INSTANCE_ID + HA_ALLOW_WRITE +
 * HA_ALLOW_CONFIG_WRITE) into the registry as the default instance, unless it is
 * already declared explicitly in VOMEHOME_INSTANCES (explicit wins).
 *
 * `fallback` is the per-instance default for entries that did not state a
 * write/config flag — permissive in brokered mode (the server is authority),
 * off in direct mode (the MCP is the only guard).
 */
function buildInstanceRegistry(
	parsed: RawInstanceAccess[],
	defaultId: string,
	defaultWrite: boolean,
	defaultConfig: boolean,
	fallback: boolean
): InstanceAccess[] {
	const list: InstanceAccess[] = parsed.map((entry) => {
		const access: InstanceAccess = {
			id: entry.id,
			write: entry.write ?? fallback,
			config: entry.config ?? fallback
		};
		if (entry.label) {
			access.label = entry.label;
		}
		return access;
	});
	if (defaultId.length > 0 && !list.some((entry) => entry.id === defaultId)) {
		list.unshift({ id: defaultId, write: defaultWrite, config: defaultConfig, label: "default" });
	}
	return list;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
	const esphomeUrl = stripTrailingSlashes((env.ESPHOME_DASHBOARD_URL ?? "").trim());
	const noderedUrl = stripTrailingSlashes((env.NODERED_URL ?? "").trim());
	const vomehomeUrl = stripTrailingSlashes(
		(env.VOMEHOME_API_URL ?? DEFAULT_VOMEHOME_API_URL).trim()
	);
	const vomehomeToken = (env.VOMEHOME_TOKEN ?? "").trim();
	const vomehomeInstanceId = (env.VOMEHOME_INSTANCE_ID ?? "").trim();
	const haToken = (env.HA_TOKEN ?? "").trim();
	// Per-instance access registry source: VOMEHOME_INSTANCES (JSON) plus the
	// default instance (VOMEHOME_INSTANCE_ID). Parsed first (ids only) so we can
	// decide brokered mode before applying the per-instance write/config default.
	const { list: parsedInstances, error: instancesError } = parseInstances(env.VOMEHOME_INSTANCES);
	// Active/default instance: the explicit VOMEHOME_INSTANCE_ID, else the first
	// declared instance in VOMEHOME_INSTANCES.
	const activeInstanceId = vomehomeInstanceId || (parsedInstances[0]?.id ?? "");
	// Brokered HA mode: the agent has a VomeHome token + at least one instance but
	// no direct HA token, so all HA traffic must go through the (policed, audited)
	// portal.
	const brokered =
		vomehomeToken.length > 0 &&
		vomehomeUrl.length > 0 &&
		activeInstanceId.length > 0 &&
		haToken.length === 0;
	// Permissions now live on the VomeHome API key and are enforced server-side
	// per instance. So in brokered mode the client guards default to permissive
	// (let the server decide); HA_ALLOW_WRITE / HA_ALLOW_CONFIG_WRITE (and the
	// per-instance flags in VOMEHOME_INSTANCES) become OPTIONAL local-only
	// restrictions. In direct mode (a raw HA token) the MCP is the sole guard,
	// so writes stay off unless explicitly enabled.
	const allowWrite = parseBoolean(env.HA_ALLOW_WRITE, brokered);
	const allowConfigWrite = parseBoolean(env.HA_ALLOW_CONFIG_WRITE, brokered);
	const instances = buildInstanceRegistry(
		parsedInstances,
		vomehomeInstanceId,
		allowWrite,
		allowConfigWrite,
		brokered
	);
	return {
		haUrl: stripTrailingSlashes((env.HA_URL ?? "").trim()),
		haToken,
		brokered,
		timeoutMs: parsePositiveInt(env.HA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
		maxResults: parsePositiveInt(env.MAX_RESULTS, DEFAULT_MAX_RESULTS),
		logLevel: parseLogLevel(env.LOG_LEVEL),
		safety: {
			allowWrite,
			allowConfigWrite,
			denyDomains: parseDomainList(env.HA_DENY_DOMAINS, DEFAULT_DENY_DOMAINS),
			allowDomains: parseDomainList(env.HA_ALLOW_DOMAINS, "")
		},
		esphome: {
			dashboardUrl: esphomeUrl,
			token: (env.ESPHOME_DASHBOARD_TOKEN ?? "").trim(),
			username: (env.ESPHOME_DASHBOARD_USERNAME ?? "").trim(),
			password: (env.ESPHOME_DASHBOARD_PASSWORD ?? "").trim(),
			// Brokered ESPHome only when brokering HA and no direct dashboard URL is
			// set (a direct URL wins, since it also supports streaming builds).
			brokered: brokered && esphomeUrl.length === 0,
			enabled: esphomeUrl.length > 0 || (brokered && esphomeUrl.length === 0)
		},
		nodered: {
			url: noderedUrl,
			token: (env.NODERED_TOKEN ?? "").trim(),
			username: (env.NODERED_USERNAME ?? "").trim(),
			password: (env.NODERED_PASSWORD ?? "").trim(),
			enabled: noderedUrl.length > 0
		},
		vomehome: {
			apiUrl: vomehomeUrl,
			token: vomehomeToken,
			instanceId: activeInstanceId,
			instances,
			instancesError,
			// Same rule as writes: in brokered mode defer to the API key (default
			// permissive); an explicit VOMEHOME_ALLOW_CREATE=false is a local block.
			allowCreate: parseBoolean(env.VOMEHOME_ALLOW_CREATE, brokered),
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
		if (!config.vomehome.instanceId && config.vomehome.instances.length === 0) {
			problems.push({
				field: "VOMEHOME_INSTANCE_ID",
				message:
					"Brokered mode needs at least one instance: set VOMEHOME_INSTANCE_ID (the instance to control), or declare VOMEHOME_INSTANCES (a JSON registry of instances with per-instance write/config flags)."
			});
		}
		if (config.vomehome.instancesError) {
			problems.push({ field: "VOMEHOME_INSTANCES", message: config.vomehome.instancesError });
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

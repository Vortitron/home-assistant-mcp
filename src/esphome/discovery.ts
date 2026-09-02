import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { buildAuthHeaders } from "./dashboardClient.js";

/**
 * Find the ESPHome dashboard without being told where it is.
 *
 * Making the user hand us `ESPHOME_DASHBOARD_URL` was the single biggest reason
 * agents reported "I can't flash your devices": the streaming build commands
 * (validate/compile/upload/logs) only run against a direct dashboard, so an
 * unset variable silently downgraded ESPHome to a read/write-YAML toy. In
 * practice the address is derivable — the dashboard is an add-on on the same
 * host as Home Assistant, publishing a known port — so we derive it.
 *
 * Two questions, answered independently so a failure in either still leaves a
 * usable guess:
 *
 * - **Which host?** Whatever `HA_URL` points at, plus the `internal_url` /
 *   `external_url` Home Assistant reports for itself. The latter is what makes
 *   this work in brokered mode, where we hold no direct HA URL at all.
 * - **Which port?** The Supervisor knows: `/addons/<slug>/info` carries the
 *   add-on's published port mapping. When there is no Supervisor (container-only
 *   Home Assistant) we fall back to ESPHome's default 6052.
 *
 * Every candidate is then *probed* rather than trusted, so what we return is a
 * dashboard that answered — never a plausible-looking URL that will fail later
 * inside a tool call.
 */

const ESPHOME_DEFAULT_PORT = 6052;
/** Probes are a liveness check on a LAN host; a slow one is a miss, not a wait. */
const PROBE_TIMEOUT_MS = 2500;

export interface DiscoveryAttempt {
	url: string;
	source: string;
	ok: boolean;
	error?: string;
}

export interface DiscoveryOutcome {
	/** The dashboard that answered a probe, or null when none did. */
	url: string | null;
	source: string | null;
	attempts: DiscoveryAttempt[];
	/** Why discovery could not even build a candidate list, when that happened. */
	note?: string;
}

export interface DiscoveryDeps {
	config: Config;
	logger: Logger;
	/** Home Assistant WebSocket command channel (`get_config`, `supervisor/api`). */
	sendCommand<T = unknown>(command: Record<string, unknown>): Promise<T>;
}

function hostOf(url: string | undefined | null): string | null {
	if (!url || typeof url !== "string") {
		return null;
	}
	try {
		return new URL(url).hostname || null;
	} catch {
		return null;
	}
}

/**
 * Hosts worth trying, best first. `HA_URL` is the strongest signal because it is
 * an address this process has already reached Home Assistant on; the URLs HA
 * reports for itself come second, and matter most in brokered mode where
 * `HA_URL` is empty.
 */
async function candidateHosts(deps: DiscoveryDeps): Promise<string[]> {
	const hosts: string[] = [];
	const push = (host: string | null): void => {
		if (host && !hosts.includes(host)) {
			hosts.push(host);
		}
	};
	push(hostOf(deps.config.haUrl));
	try {
		const haConfig = await deps.sendCommand<{ internal_url?: string; external_url?: string }>({
			type: "get_config"
		});
		push(hostOf(haConfig?.internal_url));
		push(hostOf(haConfig?.external_url));
	} catch (error) {
		deps.logger.debug(
			`ESPHome discovery: get_config failed (${error instanceof Error ? error.message : String(error)})`
		);
	}
	return hosts;
}

interface AddonNetwork {
	network?: Record<string, number | null> | null;
}

/**
 * The host port the ESPHome dashboard add-on publishes, via the Supervisor.
 *
 * Returns null when there is no Supervisor, no ESPHome add-on, or the add-on's
 * port is unpublished — all ordinary situations, so every failure here is a
 * debug line rather than an error.
 */
async function supervisorPort(deps: DiscoveryDeps): Promise<number | null> {
	const call = async <T>(endpoint: string): Promise<T> =>
		deps.sendCommand<T>({ type: "supervisor/api", endpoint, method: "get" });
	const unwrap = (result: unknown): unknown => {
		if (result && typeof result === "object") {
			const obj = result as { data?: unknown; result?: unknown };
			if (obj.data !== undefined) return obj.data;
			if (obj.result !== undefined) return obj.result;
		}
		return result;
	};

	try {
		const listed = unwrap(await call<unknown>("/addons"));
		const addons =
			listed && typeof listed === "object" && Array.isArray((listed as { addons?: unknown }).addons)
				? (listed as { addons: unknown[] }).addons
				: listed;
		if (!Array.isArray(addons)) {
			return null;
		}
		const match = addons.find((item) => {
			if (!item || typeof item !== "object") return false;
			const row = item as { slug?: string; name?: string };
			return /esphome/i.test(String(row.slug || "")) || /esphome/i.test(String(row.name || ""));
		}) as { slug?: string } | undefined;
		if (!match?.slug) {
			return null;
		}
		const info = unwrap(await call<unknown>(`/addons/${match.slug}/info`)) as AddonNetwork | null;
		const network = info?.network;
		if (!network || typeof network !== "object") {
			return null;
		}
		// Prefer the canonical 6052/tcp mapping; otherwise take the first port the
		// add-on actually publishes (a user may have remapped it).
		const mapped = network[`${ESPHOME_DEFAULT_PORT}/tcp`];
		if (typeof mapped === "number" && mapped > 0) {
			return mapped;
		}
		for (const value of Object.values(network)) {
			if (typeof value === "number" && value > 0) {
				return value;
			}
		}
		return null;
	} catch (error) {
		deps.logger.debug(
			`ESPHome discovery: Supervisor lookup failed (${error instanceof Error ? error.message : String(error)})`
		);
		return null;
	}
}

/** Does something at `url` answer as an ESPHome dashboard? */
async function probe(url: string, config: Config): Promise<{ ok: boolean; error?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`${url}/version`, {
			headers: buildAuthHeaders(config),
			signal: controller.signal
		});
		if (!response.ok) {
			return { ok: false, error: `HTTP ${response.status}` };
		}
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: error instanceof Error && error.name === "AbortError" ? "timed out" : message };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Locate a reachable ESPHome dashboard, or explain what was tried.
 *
 * The `attempts` list is deliberately part of the result: when discovery fails
 * the agent needs to tell the user *which addresses were tried and how each one
 * failed*, which is the difference between "I can't flash your devices" and
 * "port 6052 is closed on 192.168.1.50 — is the add-on running?".
 */
export async function discoverDashboardUrl(deps: DiscoveryDeps): Promise<DiscoveryOutcome> {
	const hosts = await candidateHosts(deps);
	if (hosts.length === 0) {
		return {
			url: null,
			source: null,
			attempts: [],
			note:
				"No Home Assistant host is known (HA_URL is unset and Home Assistant reported no internal_url), " +
				"so there was nothing to derive a dashboard address from."
		};
	}

	const port = await supervisorPort(deps);
	const candidates: Array<{ url: string; source: string }> = [];
	const add = (url: string, source: string): void => {
		if (!candidates.some((c) => c.url === url)) {
			candidates.push({ url, source });
		}
	};
	for (const host of hosts) {
		if (port !== null) {
			add(`http://${host}:${port}`, `supervisor add-on port on ${host}`);
		}
		add(`http://${host}:${ESPHOME_DEFAULT_PORT}`, `ESPHome default port on ${host}`);
	}

	const attempts: DiscoveryAttempt[] = [];
	for (const candidate of candidates) {
		const result = await probe(candidate.url, deps.config);
		attempts.push({ url: candidate.url, source: candidate.source, ...result });
		if (result.ok) {
			deps.logger.info(`ESPHome dashboard discovered at ${candidate.url} (${candidate.source})`);
			return { url: candidate.url, source: candidate.source, attempts };
		}
	}
	return { url: null, source: null, attempts };
}

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import {
	EsphomeError,
	createEsphomeDashboardClient,
	type EsphomeCommandRequest,
	type EsphomeCommandResult,
	type EsphomeDashboardClient
} from "./dashboardClient.js";
import { discoverDashboardUrl, type DiscoveryAttempt, type DiscoveryDeps } from "./discovery.js";

/**
 * Chooses how to reach ESPHome, once, on first use.
 *
 * Three ways in, in the order they are preferred:
 *
 * 1. **Direct, configured** — `ESPHOME_DASHBOARD_URL` was set. An explicit choice
 *    by whoever ran this server, so it wins.
 * 2. **Brokered** — a VomeHome relay carries everything, builds and logs
 *    included. Preferred over reaching the dashboard ourselves, because going
 *    direct would skip the portal's per-instance scope checks and its audit log:
 *    a revoked token would still be able to flash a device that happened to sit
 *    on the same network. On a default HAOS install it is also the only route
 *    that works at all — the add-on's web port is disabled and its ingress
 *    admits only the Supervisor and localhost.
 * 3. **Direct, discovered** — no relay, so there is no policy layer to bypass.
 *    `discovery.ts` finds the dashboard so a direct-mode user does not have to
 *    know their own port number.
 *
 * Resolution is cached per active instance, so switching instances re-resolves
 * instead of silently pointing ESPHome at the previous home's dashboard.
 */

/** How long a failed resolution sticks before we probe the network again. */
const FAILURE_TTL_MS = 60000;

export type EsphomeAccessMode = "direct-configured" | "direct-discovered" | "brokered" | "none";

export interface EsphomeAccessStatus {
	mode: EsphomeAccessMode;
	/** The dashboard in use, when reached directly. */
	url: string | null;
	/** True when validate/compile/upload/logs are available. */
	streaming: boolean;
	instance: string | null;
	attempts: DiscoveryAttempt[];
	note?: string;
}

export interface ResolvingEsphomeClient extends EsphomeDashboardClient {
	/** How ESPHome is currently reached — resolves it if that has not happened yet. */
	describe(): Promise<EsphomeAccessStatus>;
}

interface Resolution {
	client: EsphomeDashboardClient | null;
	status: EsphomeAccessStatus;
}

interface CacheEntry {
	key: string;
	expiresAt: number;
	promise: Promise<Resolution>;
}

/** Placeholder so a CacheEntry is fully built before its real promise is attached. */
const EMPTY: Resolution = {
	client: null,
	status: { mode: "none", url: null, streaming: false, instance: null, attempts: [] }
};

export function createResolvingEsphomeClient(options: {
	config: Config;
	logger: Logger;
	sendCommand: DiscoveryDeps["sendCommand"];
	/** REST-over-relay fallback, when VomeHome brokering is available. */
	brokered: EsphomeDashboardClient | null;
	activeId: () => string;
}): ResolvingEsphomeClient {
	const { config, logger, sendCommand, brokered, activeId } = options;
	let cached: CacheEntry | null = null;

	async function resolve(): Promise<Resolution> {
		const instance = activeId() || null;

		if (config.esphome.dashboardUrl) {
			return {
				client: createEsphomeDashboardClient(config, logger),
				status: {
					mode: "direct-configured",
					url: config.esphome.dashboardUrl,
					streaming: true,
					instance,
					attempts: []
				}
			};
		}

		// Before discovery, not after: an agent that can reach the dashboard
		// directly should still go through the relay, so scope checks and the
		// audit log stay in front of every build and flash.
		if (brokered) {
			return {
				client: brokered,
				status: {
					mode: "brokered",
					url: null,
					streaming: true,
					instance,
					attempts: [],
					note:
						"Brokered through VomeHome, so the portal's per-instance scopes and audit " +
						"log apply to every command."
				}
			};
		}

		const outcome = await discoverDashboardUrl({ config, logger, sendCommand });
		if (outcome.url) {
			return {
				client: createEsphomeDashboardClient(config, logger, outcome.url),
				status: {
					mode: "direct-discovered",
					url: outcome.url,
					streaming: true,
					instance,
					attempts: outcome.attempts,
					note: `Discovered automatically (${outcome.source}). Set ESPHOME_DASHBOARD_URL to pin it.`
				}
			};
		}

		return {
			client: null,
			status: {
				mode: "none",
				url: null,
				streaming: false,
				instance,
				attempts: outcome.attempts,
				note: outcome.note
			}
		};
	}

	function current(): Promise<Resolution> {
		const key = activeId() || "";
		if (cached && cached.key === key && Date.now() < cached.expiresAt) {
			return cached.promise;
		}
		// `expiresAt` starts open-ended and is tightened when the promise settles:
		// a resolution that found nothing is usually transient (the add-on was
		// still starting, the laptop was on the wrong network), so it expires and
		// gets re-probed. A successful one is kept for the life of the process —
		// probing costs seconds and the answer does not move.
		const entry: CacheEntry = { key, expiresAt: Infinity, promise: Promise.resolve(EMPTY) };
		entry.promise = resolve().then(
			(resolution) => {
				entry.expiresAt = resolution.client ? Infinity : Date.now() + FAILURE_TTL_MS;
				return resolution;
			},
			(error: unknown) => {
				entry.expiresAt = Date.now() + FAILURE_TTL_MS;
				throw error;
			}
		);
		cached = entry;
		return entry.promise;
	}

	async function client(): Promise<EsphomeDashboardClient> {
		const resolution = await current();
		if (!resolution.client) {
			throw new EsphomeError(explainNoAccess(resolution.status));
		}
		return resolution.client;
	}

	return {
		isEnabled: () => config.esphome.enabled,
		listDevices: async () => (await client()).listDevices(),
		getVersion: async () => (await client()).getVersion(),
		getConfig: async (configuration) => (await client()).getConfig(configuration),
		saveConfig: async (configuration, yaml) => (await client()).saveConfig(configuration, yaml),
		getMigrations: async (configuration) => (await client()).getMigrations(configuration),
		runCommand: async (request: EsphomeCommandRequest): Promise<EsphomeCommandResult> => {
			const resolution = await current();
			if (!resolution.client) {
				throw new EsphomeError(explainNoAccess(resolution.status));
			}
			return resolution.client.runCommand(request);
		},
		describe: async () => (await current()).status
	};
}

function formatAttempts(attempts: DiscoveryAttempt[]): string {
	if (attempts.length === 0) {
		return "";
	}
	const lines = attempts.map((a) => `  - ${a.url} (${a.source}): ${a.ok ? "ok" : a.error}`);
	return `\nAddresses tried:\n${lines.join("\n")}`;
}

/**
 * Error text for "no ESPHome at all". Written as instructions rather than a
 * diagnosis: an agent reading this should be able to act on it, or tell the user
 * exactly which address failed and why.
 */
function explainNoAccess(status: EsphomeAccessStatus): string {
	return (
		"No ESPHome dashboard could be reached. " +
		(status.note ? `${status.note} ` : "") +
		"To fix: make sure the ESPHome Device Builder add-on is running, then either set " +
		"ESPHOME_DASHBOARD_URL to its address (e.g. http://homeassistant.local:6052) or run this " +
		"MCP server on a machine that can reach it." +
		formatAttempts(status.attempts)
	);
}

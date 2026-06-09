import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import {
	EsphomeError,
	type EsphomeCommandRequest,
	type EsphomeCommandResult,
	type EsphomeDashboardClient
} from "./dashboardClient.js";

/**
 * ESPHome dashboard client that talks to a VomeHome instance *through* the
 * portal's brokered endpoints (`/api/v1/instances/<id>/esphome/*`) instead of a
 * directly-reachable dashboard.
 *
 * Same idea as the brokered HA client: the agent holds only a revocable, scoped
 * VomeHome token; the user's own Home Assistant proxies the call to its local
 * ESPHome add-on over the outbound relay. Only the REST subset is available —
 * list devices, dashboard version, and read/write of a configuration's YAML.
 * The streaming build commands (validate/compile/upload/run/logs/clean) cannot
 * be tunnelled over the request/response relay, so they reject with a clear
 * message pointing at a direct `ESPHOME_DASHBOARD_URL`.
 */

interface BrokerRequestOptions {
	method?: string;
	body?: unknown;
	expectJson?: boolean;
}

function brokerErrorDetail(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: string };
		if (parsed && typeof parsed.error === "string") {
			return parsed.error;
		}
	} catch {
		// non-JSON body; fall through to raw text
	}
	return body.slice(0, 200);
}

export function createBrokeredEsphomeDashboardClient(
	config: Config,
	logger: Logger
): EsphomeDashboardClient {
	const base = `${config.vomehome.apiUrl}/api/v1/instances/${encodeURIComponent(
		config.vomehome.instanceId
	)}/esphome`;

	async function broker<T>(path: string, options: BrokerRequestOptions = {}): Promise<T> {
		const method = options.method ?? "GET";
		const url = `${base}${path}`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
		logger.debug(`VomeHome ESPHome broker ${method} ${path}`);
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
				throw new EsphomeError(
					`VomeHome ESPHome broker ${method} ${path} responded ${response.status}: ${brokerErrorDetail(text)}`
				);
			}
			if (options.expectJson === false) {
				return text as unknown as T;
			}
			return (text.length > 0 ? JSON.parse(text) : undefined) as T;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new EsphomeError(
					`VomeHome ESPHome broker ${method} ${path} timed out after ${config.timeoutMs}ms`
				);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	function unsupported(command: string): Promise<EsphomeCommandResult> {
		return Promise.reject(
			new EsphomeError(
				`ESPHome '${command}' streams build output and is not available over the VomeHome relay. ` +
					`Set ESPHOME_DASHBOARD_URL to a directly-reachable dashboard to validate/compile/upload/run/logs.`
			)
		);
	}

	return {
		isEnabled: () => true,
		listDevices: () => broker<unknown>("/devices"),
		getVersion: () => broker<unknown>("/version"),
		getConfig: async (configuration) => {
			const data = await broker<{ yaml?: string }>(
				`/config?configuration=${encodeURIComponent(configuration)}`
			);
			return data && typeof data.yaml === "string" ? data.yaml : "";
		},
		saveConfig: async (configuration, yaml) => {
			await broker<{ saved?: boolean }>(
				`/config?configuration=${encodeURIComponent(configuration)}`,
				{ method: "POST", body: { yaml } }
			);
		},
		runCommand: (request: EsphomeCommandRequest) => unsupported(request.command)
	};
}

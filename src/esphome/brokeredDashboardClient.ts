import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import {
	EsphomeError,
	type EsphomeCommandRequest,
	type EsphomeCommandResult,
	type EsphomeDashboardClient
} from "./dashboardClient.js";

/** Build output is polled; these bound how eagerly and for how long. */
const POLL_MIN_MS = 500;
const POLL_MAX_MS = 2000;
const DEFAULT_COMMAND_TIMEOUT_MS = 300000;
const DEFAULT_MAX_LINES = 5000;

interface StreamPoll {
	lines?: string[];
	cursor?: number;
	done?: boolean;
	exit_code?: number | null;
	truncated?: boolean;
	error?: string | null;
}

/**
 * ESPHome dashboard client that talks to a VomeHome instance *through* the
 * portal's brokered endpoints (`/api/v1/instances/<id>/esphome/*`) instead of a
 * directly-reachable dashboard.
 *
 * Same idea as the brokered HA client: the agent holds only a revocable, scoped
 * VomeHome token; the user's own Home Assistant proxies the call to its local
 * ESPHome add-on over the outbound relay. Only the REST subset is available —
 * list devices, dashboard version, and read/write of a configuration's YAML.
 * The streaming build commands (validate/compile/upload/run/logs/clean) are
 * brokered too, as polled *jobs*: the portal starts one and the component bridges
 * the dashboard's WebSocket command channel over the relay. A compile runs for
 * minutes, so holding a single request open for it would be fragile; polling a
 * job is not.
 *
 * This is the **preferred** path, not a fallback. Reaching the dashboard directly
 * would skip the portal's per-instance scope checks and its audit log entirely —
 * and on a default HAOS install it does not even work, since the add-on's web
 * port is disabled and its ingress admits only the Supervisor and localhost.
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
	logger: Logger,
	activeInstanceId: () => string
): EsphomeDashboardClient {
	// Resolve the base per-request so the ESPHome client follows the active
	// instance (vomehome_use_instance / vomehome_create_instance) exactly like
	// the brokered HA client — otherwise a switch would leave ESPHome pinned to
	// the startup instance and read/write the wrong dashboard.
	function baseFor(): string {
		const id = activeInstanceId();
		if (!id) {
			throw new EsphomeError(
				"No active VomeHome instance is selected for ESPHome. Call vomehome_use_instance first."
			);
		}
		return `${config.vomehome.apiUrl}/api/v1/instances/${encodeURIComponent(id)}/esphome`;
	}

	async function broker<T>(path: string, options: BrokerRequestOptions = {}): Promise<T> {
		const method = options.method ?? "GET";
		const url = `${baseFor()}${path}`;
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

	/**
	 * Run one streaming build command as a polled job.
	 *
	 * Poll interval backs off from `POLL_MIN_MS` to `POLL_MAX_MS`: a `validate`
	 * finishes in seconds and should feel immediate, while a `compile` runs for
	 * minutes and should not be asked about 600 times.
	 */
	async function runStreamJob(request: EsphomeCommandRequest): Promise<EsphomeCommandResult> {
		const deadline = Date.now() + (request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
		const maxLines = request.maxLines ?? DEFAULT_MAX_LINES;
		const started = await broker<{ job_id?: string }>("/stream", {
			method: "POST",
			body: {
				command: request.command,
				configuration: request.configuration,
				...(request.port ? { port: request.port } : {})
			}
		});
		const jobId = started?.job_id;
		if (!jobId) {
			throw new EsphomeError("The relay did not return an ESPHome job id.");
		}

		const lines: string[] = [];
		let truncated = false;
		let cursor = 0;
		let wait = POLL_MIN_MS;
		for (;;) {
			if (Date.now() >= deadline) {
				// Leave nothing running on the home just because we stopped watching.
				await broker(`/stream/${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(
					() => undefined
				);
				return {
					command: request.command,
					configuration: request.configuration,
					exitCode: null,
					output: lines.join(""),
					truncated: true,
					timedOut: true
				};
			}
			await new Promise((resolve) => setTimeout(resolve, wait));
			wait = Math.min(wait * 2, POLL_MAX_MS);
			const poll = await broker<StreamPoll>(
				`/stream/${encodeURIComponent(jobId)}?cursor=${cursor}`
			);
			for (const line of poll?.lines ?? []) {
				if (lines.length < maxLines) {
					lines.push(line);
				} else {
					truncated = true;
				}
			}
			cursor = typeof poll?.cursor === "number" ? poll.cursor : cursor;
			truncated = truncated || Boolean(poll?.truncated);
			if (poll?.done) {
				if (poll.error) {
					throw new EsphomeError(`ESPHome ${request.command} failed: ${poll.error}`);
				}
				return {
					command: request.command,
					configuration: request.configuration,
					exitCode: typeof poll.exit_code === "number" ? poll.exit_code : null,
					output: lines.join(""),
					truncated
				};
			}
		}
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
		runCommand: runStreamJob
	};
}

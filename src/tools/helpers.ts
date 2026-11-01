import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { HaRestClient } from "../ha/restClient.js";
import { HaApiError } from "../ha/restClient.js";
import { VomeHomeError } from "../vomehome/client.js";
import type { HaWsClient } from "../ha/wsClient.js";
import type { EsphomeClient } from "../esphome/client.js";
import { NodeRedError } from "../nodered/client.js";
import type { NodeRedClient } from "../nodered/client.js";
import type { VomeHomeClient } from "../vomehome/client.js";
import type { InstanceManager } from "../vomehome/instances.js";

/**
 * Everything a tool handler needs, assembled once in index.ts and threaded
 * through explicitly (never via a module-level singleton).
 */
export interface ToolContext {
	config: Config;
	logger: Logger;
	/** Stable HA REST client that always targets the active instance (via `instances`). */
	rest: HaRestClient;
	ws: HaWsClient;
	esphome: EsphomeClient;
	nodered: NodeRedClient;
	vomehome: VomeHomeClient;
	/** Multi-instance access manager: active instance + per-instance write/config. */
	instances: InstanceManager;
	/**
	 * How the session's starting instance was picked, when a server set it up
	 * (stdio from the environment, the hosted server per session). Present, it
	 * turns on the first-call check that the instance is actually online
	 * (`instanceCheck.ts`); tests that build a context by hand leave it out.
	 */
	instanceChoice?: InstanceChoice;
}

/**
 * Where the starting instance came from. Only "default" -- the first one the
 * account lists, which nobody picked -- may be swapped for an online one;
 * the others are somebody's choice and are kept, with a warning if offline.
 */
export interface InstanceChoice {
	source: "pinned" | "remembered" | "configured" | "default";
}

export function textResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

export function jsonResult(value: unknown): CallToolResult {
	return textResult(JSON.stringify(value, null, 2));
}

export function errorResult(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

export function toErrorMessage(error: unknown): string {
	if (error instanceof HaApiError || error instanceof VomeHomeError || error instanceof NodeRedError) {
		const body = error.body ? ` Body: ${error.body.slice(0, 800)}` : "";
		return `${error.message}${error.status ? ` (status ${error.status})` : ""}.${body}`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Wraps a tool handler so any thrown error becomes a structured `isError`
 * result rather than crashing the JSON-RPC connection.
 */
export async function runTool(
	logger: Logger,
	name: string,
	fn: () => Promise<CallToolResult>
): Promise<CallToolResult> {
	try {
		return await fn();
	} catch (error) {
		const message = toErrorMessage(error);
		logger.warn(`Tool '${name}' failed: ${message}`);
		return errorResult(`Tool '${name}' failed: ${message}`);
	}
}

export interface Truncated<T> {
	items: T[];
	total: number;
	returned: number;
	truncated: boolean;
}

export function truncate<T>(items: T[], limit: number): Truncated<T> {
	const safeLimit = Math.max(1, limit);
	const returned = items.slice(0, safeLimit);
	return {
		items: returned,
		total: items.length,
		returned: returned.length,
		truncated: items.length > returned.length
	};
}

export function getFriendlyName(attributes: Record<string, unknown>): string | undefined {
	const value = attributes.friendly_name;
	return typeof value === "string" ? value : undefined;
}

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

/**
 * Client for the Node-RED Admin API (the flow editor that ships as a Home
 * Assistant add-on, or any standalone Node-RED).
 *
 * Node-RED stores automations as **flows**: a JSON array of node objects, each
 * tagged with the id of the tab (`z`) it lives on. The admin API speaks plain
 * JSON:
 *
 * - `GET /flows` (with `Node-RED-API-Version: v2`) -> `{ flows, rev }` — the
 *   whole config plus a revision string used for optimistic concurrency.
 * - `POST /flows` (v2, `Node-RED-Deployment-Type: full|flows|nodes|reload`) —
 *   replace the whole config and deploy.
 * - `GET /flow/:id` / `POST /flow` / `PUT /flow/:id` / `DELETE /flow/:id` —
 *   work on a single tab, which is far safer than rewriting everything.
 * - `GET /nodes` — the installed node palette (which node types exist).
 * - `GET /settings` — runtime info (version, etc.); used by `doctor`.
 *
 * Auth: when Node-RED's `adminAuth` is enabled, calls need a bearer token. We
 * accept one directly (`NODERED_TOKEN`) or exchange a username/password for one
 * via `POST /auth/token` (cached for the process). An unsecured admin API
 * (trusted network / behind ingress or an auth-terminating proxy) needs no auth
 * at all — mirroring how the ESPHome dashboard client behaves.
 */

export type NodeRedDeploymentType = "full" | "flows" | "nodes" | "reload";

const DEPLOYMENT_TYPES: readonly NodeRedDeploymentType[] = ["full", "flows", "nodes", "reload"];

export interface NodeRedFlowsResult {
	/** The full flow config (array of node objects). */
	flows: unknown;
	/** Revision of the current config; pass back to setFlows to avoid clobbering. */
	rev?: string;
}

export interface SetFlowsOptions {
	rev?: string;
	deploymentType?: NodeRedDeploymentType;
}

export interface NodeRedClient {
	isEnabled(): boolean;
	getSettings(): Promise<unknown>;
	listNodes(): Promise<unknown>;
	getFlows(): Promise<NodeRedFlowsResult>;
	getFlow(id: string): Promise<unknown>;
	setFlows(flows: unknown, options?: SetFlowsOptions): Promise<unknown>;
	createFlow(flow: unknown): Promise<unknown>;
	updateFlow(id: string, flow: unknown): Promise<unknown>;
	deleteFlow(id: string): Promise<void>;
}

/** Thrown for any non-2xx Node-RED admin response (or a timeout). */
export class NodeRedError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(message: string, status = 0, body = "") {
		super(message);
		this.name = "NodeRedError";
		this.status = status;
		this.body = body;
	}
}

export function isNodeRedDeploymentType(value: string): value is NodeRedDeploymentType {
	return (DEPLOYMENT_TYPES as readonly string[]).includes(value);
}

interface RequestOptions {
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
	/** Parse the response as JSON (default true). */
	expectJson?: boolean;
}

export function createNodeRedClient(config: Config, logger: Logger): NodeRedClient {
	const baseUrl = config.nodered.url;
	const { token, username, password } = config.nodered;
	// Lazily-fetched bearer token from the password grant, cached for the process.
	let cachedToken = token;

	function assertEnabled(): void {
		if (!config.nodered.enabled) {
			throw new NodeRedError(
				"Node-RED is not configured. Set NODERED_URL (e.g. http://homeassistant.local:1880) to enable Node-RED tools."
			);
		}
	}

	async function fetchPasswordToken(): Promise<string> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), config.timeoutMs);
		try {
			const form = new URLSearchParams({
				client_id: "node-red-admin",
				grant_type: "password",
				scope: "*",
				username,
				password
			});
			const response = await fetch(`${baseUrl}/auth/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: form.toString(),
				signal: controller.signal
			});
			const text = await response.text();
			if (!response.ok) {
				throw new NodeRedError(
					`Node-RED POST /auth/token responded ${response.status} ${response.statusText}`,
					response.status,
					text
				);
			}
			const parsed = text.length > 0 ? (JSON.parse(text) as { access_token?: unknown }) : {};
			const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
			if (!accessToken) {
				throw new NodeRedError("Node-RED /auth/token did not return an access_token.");
			}
			return accessToken;
		} finally {
			clearTimeout(timer);
		}
	}

	async function authHeader(): Promise<Record<string, string>> {
		if (cachedToken) {
			return { Authorization: `Bearer ${cachedToken}` };
		}
		if (username && password) {
			cachedToken = await fetchPasswordToken();
			return { Authorization: `Bearer ${cachedToken}` };
		}
		return {};
	}

	async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
		assertEnabled();
		const method = options.method ?? "GET";
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), config.timeoutMs);
		logger.debug(`Node-RED ${method} ${path}`);
		try {
			const response = await fetch(`${baseUrl}${path}`, {
				method,
				headers: {
					Accept: "application/json",
					...(await authHeader()),
					...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
					...options.headers
				},
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: controller.signal
			});
			const text = await response.text();
			if (!response.ok) {
				throw new NodeRedError(
					`Node-RED ${method} ${path} responded ${response.status} ${response.statusText}`,
					response.status,
					text
				);
			}
			if (options.expectJson === false) {
				return undefined as T;
			}
			return (text.length > 0 ? JSON.parse(text) : undefined) as T;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new NodeRedError(
					`Node-RED ${method} ${path} timed out after ${config.timeoutMs}ms`
				);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	const apiV2 = { "Node-RED-API-Version": "v2" };

	async function getFlows(): Promise<NodeRedFlowsResult> {
		const payload = await request<{ flows?: unknown; rev?: unknown }>("/flows", {
			headers: apiV2
		});
		return {
			flows: payload?.flows ?? payload,
			rev: typeof payload?.rev === "string" ? payload.rev : undefined
		};
	}

	async function setFlows(flows: unknown, options: SetFlowsOptions = {}): Promise<unknown> {
		const body: Record<string, unknown> = { flows };
		if (options.rev !== undefined) {
			body.rev = options.rev;
		}
		return request<unknown>("/flows", {
			method: "POST",
			body,
			headers: {
				...apiV2,
				"Node-RED-Deployment-Type": options.deploymentType ?? "full"
			}
		});
	}

	return {
		isEnabled: () => config.nodered.enabled,
		getSettings: () => request<unknown>("/settings"),
		listNodes: () => request<unknown>("/nodes"),
		getFlows,
		getFlow: (id) => request<unknown>(`/flow/${encodeURIComponent(id)}`),
		setFlows,
		createFlow: (flow) => request<unknown>("/flow", { method: "POST", body: flow }),
		updateFlow: (id, flow) =>
			request<unknown>(`/flow/${encodeURIComponent(id)}`, { method: "PUT", body: flow }),
		deleteFlow: async (id) => {
			await request<void>(`/flow/${encodeURIComponent(id)}`, {
				method: "DELETE",
				expectJson: false
			});
		}
	};
}

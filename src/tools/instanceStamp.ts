import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./helpers.js";

/**
 * Stamp every tool reply with which Home Assistant answered it.
 *
 * An agent driving several homes has no way to tell, from a reply alone,
 * which one it reached. That is not hypothetical: an agent standing up a demo
 * was handed a routing hint, followed it, and overwrote a live customer's
 * configuration.yaml — the reply it read looked exactly like a correct one.
 * A second agent later stopped work entirely because different endpoints
 * disagreed about the target and it could not tell which to believe.
 *
 * Both had to *infer* the target. So every reply now says it outright, and
 * says it in terms a reader can check: the instance id, and the home's own
 * name, version and size. An id alone proves nothing — it only echoes what
 * was asked for — whereas "GamlaBio, 355 components" next to a request for a
 * fresh demo box is wrong on sight.
 *
 * The identity is read through `ctx.rest`, the same client the tool used, so
 * it describes where the call actually landed rather than where it was aimed.
 */

const TTL_MS = 30_000;

interface Identity {
	id: string;
	home?: string;
	version?: string;
	components?: number;
	error?: string;
}

interface CacheEntry {
	identity: Identity;
	at: number;
}

/** Marker every stamp starts with, so it is greppable and unmistakable. */
export const STAMP_PREFIX = "[vome-instance]";

function renderStamp(identity: Identity): string {
	if (identity.error) {
		return (
			`${STAMP_PREFIX} target=${identity.id} — identity UNVERIFIED ` +
			`(${identity.error}). Do not assume this reply came from the instance you meant.`
		);
	}
	const bits = [`target=${identity.id}`];
	if (identity.home !== undefined) bits.push(`home=${JSON.stringify(identity.home)}`);
	if (identity.version !== undefined) bits.push(`ha=${identity.version}`);
	if (identity.components !== undefined) bits.push(`components=${identity.components}`);
	return `${STAMP_PREFIX} ${bits.join(" ")}`;
}

/**
 * Reads (and briefly caches) the identity of the active instance.
 *
 * Cached per instance id: a stamp is only useful if it is cheap enough to put
 * on every reply, and an agent makes many calls a minute. The window is short
 * so a home that moves, restarts or is renamed corrects itself quickly.
 */
export function createIdentityReader(ctx: ToolContext): () => Promise<Identity> {
	const cache = new Map<string, CacheEntry>();

	return async function identity(): Promise<Identity> {
		const id = ctx.instances.activeId();
		const hit = cache.get(id);
		if (hit && Date.now() - hit.at < TTL_MS) {
			return hit.identity;
		}
		let result: Identity;
		try {
			const config = (await ctx.rest.getConfig()) as {
				location_name?: string;
				version?: string;
				components?: unknown[];
			};
			result = {
				id,
				home: config?.location_name,
				version: config?.version,
				components: Array.isArray(config?.components) ? config.components.length : undefined
			};
		} catch (error) {
			// Never let the stamp fail the tool it is describing. An
			// unverified stamp that says so is more use than no stamp: it
			// tells the reader the reply cannot be trusted to be from the
			// instance they asked for.
			result = { id, error: error instanceof Error ? error.message : String(error) };
		}
		cache.set(id, { identity: result, at: Date.now() });
		return result;
	};
}

/** Appends the stamp to a tool result as its own trailing text block. */
export function appendStamp(result: CallToolResult, identity: Identity): CallToolResult {
	const stamp = renderStamp(identity);
	// A separate content block, never merged into the payload: callers that
	// JSON.parse the first block keep working unchanged.
	return {
		...result,
		content: [...(result.content ?? []), { type: "text" as const, text: stamp }]
	};
}

/**
 * Returns a proxy of ``server`` whose ``registerTool`` wraps each handler so
 * its result carries the stamp.
 *
 * Done here rather than in ``runTool`` because every tool already funnels
 * through registration, and a per-call-site change across 80-odd tools is a
 * change 80-odd future tools can forget to make. A tool cannot opt out of
 * being registered, so it cannot opt out of saying where it ran.
 */
export function withInstanceStamp(server: McpServer, ctx: ToolContext): McpServer {
	const identity = createIdentityReader(ctx);
	const original = server.registerTool.bind(server);

	const wrapped = ((name: string, config: unknown, handler: unknown) => {
		const stampedHandler = async (...args: unknown[]): Promise<CallToolResult> => {
			const result = (await (handler as (...a: unknown[]) => Promise<CallToolResult>)(
				...args
			)) as CallToolResult;
			try {
				return appendStamp(result, await identity());
			} catch {
				return result;
			}
		};
		return (original as (n: string, c: unknown, h: unknown) => unknown)(
			name,
			config,
			stampedHandler
		);
	}) as unknown as McpServer["registerTool"];

	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop === "registerTool") return wrapped;
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		}
	}) as McpServer;
}

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./helpers.js";
import { HaFailoverError, HaRestartingError } from "../ha/restClient.js";
import { isNotRunning } from "../ha/restart.js";
import { DIRECT_INSTANCE_ID } from "../vomehome/instances.js";

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

/**
 * How long a *failed* read stands before the next reply tries again.
 *
 * It used to stand for the full TTL, so one blip became half a minute of
 * "UNVERIFIED" on every reply, and an agent stopping a home for a restart
 * (the read 502s while HA is down) got a second half minute straight after.
 * An agent told so often enough that it cannot trust its replies either
 * stops or learns to ignore the warning, and both defeat the stamp. Not zero,
 * so a home that is really down is not asked again on every call of a burst.
 */
const FAILURE_TTL_MS = 3_000;

interface Identity {
	id: string;
	home?: string;
	version?: string;
	components?: number;
	/** Core state, only when it is not RUNNING (Home Assistant answered while still starting). */
	core?: string;
	error?: string;
	/**
	 * The identity read failed the way a restart fails. Not an identity
	 * problem, and said so in those words: "UNVERIFIED" on every reply while a
	 * home restarts taught agents to distrust (or ignore) the stamp.
	 */
	restarting?: boolean;
	/** The read failed because a CHAP standby is running the home: who, as "'name' (id)". */
	failover?: string;
}

interface CacheEntry {
	identity: Identity;
	at: number;
}

/** Marker every stamp starts with, so it is greppable and unmistakable. */
export const STAMP_PREFIX = "[vome-instance]";

function renderStamp(identity: Identity): string {
	if (identity.failover) {
		return (
			`${STAMP_PREFIX} target=${identity.id} — CHAP failover is active: the standby ${identity.failover} is ` +
			`running this home; identity not checked.`
		);
	}
	if (identity.restarting) {
		return (
			`${STAMP_PREFIX} target=${identity.id} — Home Assistant is restarting or not answering; ` +
			`identity not checked.`
		);
	}
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
	if (identity.core !== undefined) bits.push(`core=${identity.core}`);
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
		if (hit && Date.now() - hit.at < (hit.identity.error ? FAILURE_TTL_MS : TTL_MS)) {
			return hit.identity;
		}
		let result: Identity;
		try {
			const config = (await readConfig(ctx)) as {
				location_name?: string;
				version?: string;
				components?: unknown[];
				state?: unknown;
			};
			result = {
				id,
				home: config?.location_name,
				version: config?.version,
				components: Array.isArray(config?.components) ? config.components.length : undefined,
				...(isNotRunning(config?.state) ? { core: config.state } : {})
			};
		} catch (error) {
			// Never let the stamp fail the tool it is describing. An
			// unverified stamp that says so is more use than no stamp: it
			// tells the reader the reply cannot be trusted to be from the
			// instance they asked for.
			result = {
				id,
				error: error instanceof Error ? error.message : String(error),
				...(error instanceof HaRestartingError ? { restarting: true } : {}),
				...(error instanceof HaFailoverError ? { failover: `'${error.standbyName}' (${error.standbyId})` } : {})
			};
			// Logged, because the reader only sees the stamp: a run of
			// unverified replies on 14 Oct left no trace of why.
			ctx.logger?.warn(`Instance stamp: could not read ${id}'s identity: ${describe(error)}`);
		}
		cache.set(id, { identity: result, at: Date.now() });
		return result;
	};
}

/**
 * The config read, retried once when no answer came back at all.
 *
 * A request that dies before the server sees it (a pooled connection the
 * other end had already closed) throws a bare TypeError from fetch rather
 * than an HTTP error. That says nothing about the home, so it is worth one
 * immediate retry; an HTTP error or a timeout is a real answer and is not.
 */
async function readConfig(ctx: ToolContext): Promise<unknown> {
	try {
		return await ctx.rest.getConfig();
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return await ctx.rest.getConfig();
	}
}

/** The message plus fetch's underlying cause (e.g. ECONNRESET), which is where the detail is. */
function describe(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = (error as { cause?: unknown }).cause;
	if (cause instanceof Error) {
		const code = (cause as { code?: unknown }).code;
		return `${error.message} (${typeof code === "string" ? `${code}: ` : ""}${cause.message})`;
	}
	return error.message;
}

const INSTANCE_ARG = "instance_id";

/**
 * The tool's config with an optional ``instance_id`` added, or null when the
 * tool should not get one.
 *
 * The stamp tells an agent where a reply came from, but only after the
 * fact, and agents rarely read it: three times a read answered from the
 * wrong house ("entity not found", an empty history) because another window
 * of the same client had moved the shared starting choice. Naming the home on
 * a call makes that impossible: the call goes to the home named. Optional,
 * so existing callers are unaffected; skipped for the vomehome_* tools, where
 * ``instance_id`` names the home to act on, and for tools that declare their
 * own (the write tools, where it must be given whenever more than one home is
 * in reach, and is routed the same way — see {@link ownsInstanceArg}).
 */
function guardableSchema(name: string, config: unknown): Record<string, unknown> | null {
	if (name.startsWith("vomehome_") || !config || typeof config !== "object") return null;
	const shape = (config as { inputSchema?: unknown }).inputSchema;
	// No input schema means the handler is called without an arguments object.
	if (!shape || typeof shape !== "object" || INSTANCE_ARG in shape) return null;
	return {
		...(config as Record<string, unknown>),
		inputSchema: {
			...(shape as Record<string, unknown>),
			[INSTANCE_ARG]: z
				.string()
				.optional()
				.describe(
					"Optional: the instance to run this one call on (as listed by vomehome_list_instances). Routes this " +
						"call to that home without switching the session, with that home's own write/config permission; " +
						"the reply's stamp names it. An unknown id is refused. Omit to use the session's active instance."
				)
		}
	};
}

/**
 * True for a (non-vomehome) tool that declares its own ``instance_id``: the
 * file and login writes, where naming the home is required whenever the
 * session can reach more than one (see {@link writeTarget}).
 */
function ownsInstanceArg(name: string, config: unknown): boolean {
	if (name.startsWith("vomehome_") || !config || typeof config !== "object") return false;
	const shape = (config as { inputSchema?: unknown }).inputSchema;
	return Boolean(shape && typeof shape === "object" && INSTANCE_ARG in shape);
}

function refusal(text: string): CallToolResult {
	return { isError: true, content: [{ type: "text", text }] };
}

/**
 * The homes this session can reach, which is what decides whether a write
 * may leave out ``instance_id``.
 *
 * Brokered, that is the instance registry: on the hosted server, the
 * instances the portal lists for the token (each session's registry is built
 * from that list); on stdio, VOMEHOME_INSTANCE_ID and VOMEHOME_INSTANCES. Both
 * grow when the session creates an instance or switches to one not listed
 * yet, so once a second home is in play, writes must name theirs again. A
 * direct connection (HA_URL) has exactly one Home Assistant.
 */
export function visibleInstanceIds(ctx: ToolContext): string[] {
	if (!ctx.config.brokered) return [DIRECT_INSTANCE_ID];
	return ctx.instances.list().map((entry) => entry.id);
}

const LISTED_IN_REFUSAL = 10;

/**
 * Where a write that may or may not name its home goes: the named one, the
 * only one in reach when it names none, or a refusal saying why it must.
 *
 * Writes used to require ``instance_id`` outright, while reads took it
 * optionally ("write tools require the instance id while read tools
 * don't"). The requirement exists for the case where it can be wrong: a
 * session that reaches several homes, where the ambient active one has
 * drifted before (2026-09-18, a customer's configuration.yaml). With one
 * home in reach there is nothing to confuse, so the write goes there and the
 * stamp says it was the default.
 */
export function writeTarget(
	ctx: ToolContext,
	named: unknown,
	noun = "write"
): { id: string; defaulted: boolean; refusal?: undefined } | { refusal: string } {
	if (typeof named === "string" && named.trim()) return { id: named.trim(), defaulted: false };
	const visible = visibleInstanceIds(ctx);
	if (visible.length === 1) return { id: visible[0] as string, defaulted: true };
	if (visible.length === 0) {
		return {
			refusal:
				`Refused: this session has no home to ${noun} to yet. Nothing was changed. Select one with ` +
				"vomehome_use_instance, then name it with instance_id."
		};
	}
	const shown = visible.slice(0, LISTED_IN_REFUSAL).join(", ") + (visible.length > LISTED_IN_REFUSAL ? ", …" : "");
	return {
		refusal:
			`Refused: ${ctx.config.hosted ? "this key reaches" : "this session reaches"} ${visible.length} homes ` +
			`(${shown}): name the one this ${noun} is for with instance_id. Nothing was changed. It is only ` +
			"optional when a single home is in reach, so a write never lands on whichever home the session " +
			"happens to be on."
	};
}

/**
 * The write tools' own check, run inside the handler: refuses a write aimed
 * at a home other than the one this call targets, or one that names no home
 * while several are in reach; null when it may go ahead.
 *
 * Since 0.17 the tool wrapper routes the named instance for the call, so
 * belief and reality cannot disagree there; this stays as defence in depth
 * for a handler run without the wrapper. ``nothing`` is what the refusal
 * says did not happen ("Nothing was written.").
 */
export function refuseWrongHome(
	ctx: ToolContext,
	instanceId: string | undefined,
	noun: string,
	nothing: string
): CallToolResult | null {
	if (!ctx.config.brokered) return null;
	const target = writeTarget(ctx, instanceId, noun);
	if (target.refusal !== undefined) return refusal(target.refusal);
	const targeting = ctx.instances.activeId();
	if (target.id !== targeting) {
		return refusal(
			`Refused: this session is targeting "${targeting}", but the ${noun} names "${target.id}". ${nothing} ` +
				`If "${target.id}" is the home you mean, name it with instance_id (or select it with ` +
				"vomehome_use_instance) and try again — do not assume the session is still where you left it."
		);
	}
	return null;
}

/**
 * Where a call naming ``named`` goes: routed to that instance (``id``), left
 * on the session's (``id: null``), or refused.
 *
 * Only an instance the session knows — declared, listed for the token by the
 * hosted server, created, or switched to — is routed to; anything else is
 * refused with the ones it can use, so a typo or a stale id never quietly
 * answers from the active home. Brokered calls route by instance id alone
 * (another /api/v1/instances/<id> base). A direct connection has one Home
 * Assistant and nowhere to route: an optional ``instance_id`` naming anything
 * else is refused rather than answered from it, while the write tools' own
 * argument is left as it always was there (it cannot mean anything but the
 * one home).
 */
function routeFor(
	ctx: ToolContext,
	named: unknown,
	owned: boolean
): { id: string | null; refusal?: undefined } | { refusal: CallToolResult } {
	if (typeof named !== "string" || !named.trim()) return { id: null };
	const id = named.trim();
	if (!ctx.config.brokered) {
		if (owned || id === DIRECT_INSTANCE_ID) return { id: null };
		return {
			refusal: refusal(
				`Refused: this server talks to one Home Assistant directly (HA_URL), not through VomeHome, so ` +
					`instance_id "${id}" cannot route the call anywhere. Nothing was read or changed. Omit instance_id.`
			)
		};
	}
	if (ctx.instances.has(id)) return { id };
	const known = ctx.instances.list().map((entry) => entry.id);
	return {
		refusal: refusal(
			`Refused: "${id}" is not an instance this session can reach, so nothing was read, written or deleted. ` +
				`Known instances: ${known.length > 0 ? known.join(", ") : "(none)"} (this session is on ` +
				`"${ctx.instances.sessionActiveId()}"). Use one of those ids, or vomehome_use_instance for an instance ` +
				"the API key can reach that is not listed yet."
		)
	};
}

/**
 * Appends the stamp to a tool result as its own trailing text block. When the
 * call was routed away from the session's own instance (``sessionId``), the
 * stamp says so, so nobody takes the session to have moved; when a write
 * left out ``instance_id`` and went to the only home in reach
 * (``defaulted``), it says that too.
 */
export function appendStamp(
	result: CallToolResult,
	identity: Identity,
	sessionId?: string,
	defaulted = false
): CallToolResult {
	let stamp = renderStamp(identity);
	if (sessionId !== undefined && sessionId !== identity.id) {
		stamp += ` (this call only; session still on ${sessionId})`;
	}
	if (defaulted) {
		stamp += " (instance_id omitted: the only home this session reaches)";
	}
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
		const guarded = guardableSchema(name, config);
		const owned = !guarded && ownsInstanceArg(name, config);
		const stampedHandler = async (...args: unknown[]): Promise<CallToolResult> => {
			let named: unknown;
			let defaulted = false;
			if (guarded || owned) {
				const params = (args[0] ?? {}) as Record<string, unknown>;
				named = params[INSTANCE_ARG];
				if (guarded) {
					// The tool never sees the argument it did not declare.
					const { [INSTANCE_ARG]: _named, ...rest } = params;
					args[0] = rest;
				} else {
					// A write tool: one rule for all of them. Named, it routes as
					// below; omitted, it goes to the only home in reach or is
					// refused with the homes to choose from.
					const target = writeTarget(ctx, named);
					if (target.refusal !== undefined) {
						return appendStamp(
							refusal(target.refusal),
							await identity().catch(() => ({ id: ctx.instances.activeId() }))
						);
					}
					if (target.defaulted) {
						defaulted = true;
						named = target.id;
						// The handler's own check sees the home it is going to.
						args[0] = { ...params, [INSTANCE_ARG]: target.id };
					}
				}
			}
			const route = routeFor(ctx, named, owned);
			if (route.refusal) {
				return appendStamp(route.refusal, await identity().catch(() => ({ id: ctx.instances.activeId() })));
			}
			const run = async (): Promise<CallToolResult> => {
				const result = (await (handler as (...a: unknown[]) => Promise<CallToolResult>)(
					...args
				)) as CallToolResult;
				let stamp: Identity;
				try {
					stamp = await identity();
				} catch {
					return result;
				}
				let session: string | undefined;
				try {
					session = ctx.instances.sessionActiveId();
				} catch {
					session = undefined;
				}
				return appendStamp(result, stamp, session, defaulted);
			};
			// Routed: the handler, its permission checks and the stamp all run
			// against the named instance; the session's own stays put.
			return route.id === null ? run() : ctx.instances.runOn(route.id, run);
		};
		return (original as (n: string, c: unknown, h: unknown) => unknown)(
			name,
			guarded ?? config,
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

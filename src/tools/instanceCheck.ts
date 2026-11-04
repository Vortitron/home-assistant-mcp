import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VomeHomeInstance } from "../vomehome/client.js";
import type { InstanceChoice, ToolContext } from "./helpers.js";

/**
 * On a session's first tool call, check that the instance it starts on is
 * online, and say so plainly when it is not.
 *
 * Reported from a week of real use: an old relay instance (a home since
 * re-linked under a new id, its relay long disconnected) was still on the
 * account and was the remembered target when a session began, so the first
 * calls failed with 502s and nothing said why. The start was right by every
 * rule the server had: it was remembered, and still reachable *by the token*.
 * Nothing asked whether the home itself was there.
 *
 * What it does about it depends on who picked the instance:
 *
 *  - Picked by somebody (a `?instance=` pin, a remembered switch, or
 *    VOMEHOME_INSTANCE_ID): kept. Moving a session to a *different* home
 *    without being asked is the worse failure -- an agent that thinks it is
 *    in one house acting in another has happened, and cost a customer their
 *    configuration.yaml. So the reply warns, loudly, and names the online
 *    ones to switch to.
 *  - Nobody picked it (the first instance the account lists): the session
 *    moves to the first online instance and the reply says so. This is not
 *    remembered as a choice (see `InstanceManager.fallBackTo`).
 *
 * The notice is its own trailing text block, like the instance stamp, so a
 * caller parsing the first block is unaffected. It rides on the first reply,
 * and for the warning also on every error reply while the session is still
 * on the offline home and nobody has switched -- that is when it explains the
 * failure. A check that cannot finish quickly is dropped rather than holding
 * up the call.
 */

const CHECK_TIMEOUT_MS = 5_000;

/** Marker every notice starts with, alongside the stamp's `[vome-instance]`. */
export const NOTICE_PREFIX = "[vome-notice]";

/** Tools where the caller is choosing the instance right now: no default to second-guess. */
const CHOOSING_TOOLS = new Set(["vomehome_use_instance", "vomehome_create_instance"]);

interface Notice {
	text: string;
	/** Instance whose being offline the notice is about; it is repeated on errors while still on it. */
	offlineId?: string;
}

function label(instance: VomeHomeInstance): string {
	return instance.name ? `${instance.id} ("${instance.name}")` : instance.id;
}

/** Offline only on the portal's own word: unknown live status is not offline. */
export function isOffline(instance: VomeHomeInstance): boolean {
	return instance.live?.reachable === false;
}

function isOnline(instance: VomeHomeInstance): boolean {
	return instance.live?.reachable === true;
}

/** Why the portal counts it offline, in the terms of how it is reached. */
export function offlineReason(instance: VomeHomeInstance): string {
	switch (instance.kind) {
		case "relay":
			return "its relay is not connected: the Vome component in that home is not dialled in";
		case "external":
			return "its Home Assistant is not answering the portal";
		default:
			return "the portal cannot reach its Home Assistant";
	}
}

const WHY_STARTED: Record<InstanceChoice["source"], string> = {
	pinned: "it is pinned with ?instance= in this client's server URL",
	remembered: "it was remembered from an earlier session of this client",
	configured: "VOMEHOME_INSTANCE_ID names it",
	default: "it is the first instance on this account"
};

/** Decides what, if anything, to do and say about the starting instance. */
export async function checkStartingInstance(ctx: ToolContext): Promise<Notice | null> {
	const choice = ctx.instanceChoice;
	if (!choice || !ctx.config.brokered || !ctx.vomehome.isEnabled()) return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let instances: VomeHomeInstance[];
	try {
		instances = await Promise.race([
			ctx.vomehome.listInstances({ live: true }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timed out")), CHECK_TIMEOUT_MS);
			})
		]);
	} catch (error) {
		ctx.logger.debug(`Starting-instance check skipped: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
	// The caller may have switched while the check ran; then it is their choice.
	if (ctx.instances.chosenId() !== null) return null;
	// The session's own start, not where this one call may be routed.
	const startId = ctx.instances.sessionActiveId();
	const start = instances.find((instance) => instance.id === startId);
	if (!start || !isOffline(start)) return null;

	const online = instances.filter((instance) => instance.id !== startId && isOnline(instance));
	// Only ever fall back to an instance this session may target as configured.
	const fallback = choice.source === "default" ? online.find((instance) => ctx.instances.has(instance.id)) : undefined;
	if (fallback) {
		ctx.instances.fallBackTo(fallback.id);
		ctx.logger.info(`Starting instance ${startId} is offline; session fell back to ${fallback.id}`);
		return {
			text:
				`${NOTICE_PREFIX} This session started on ${label(fallback)}, not ${label(start)}: ${start.id} is the ` +
				`first instance on this account but is OFFLINE (${offlineReason(start)}), and nobody had chosen it. ` +
				`If you meant ${start.id}, switch with vomehome_use_instance. If it is a retired home, remove it in ` +
				"the Vome portal so it stops being listed."
		};
	}
	const others =
		online.length > 0
			? `Online now: ${online.map(label).join(", ")}. Switch with vomehome_use_instance.`
			: "No other instance on this account is online either.";
	return {
		offlineId: startId,
		text:
			`${NOTICE_PREFIX} WARNING: this session is targeting ${label(start)}, which is OFFLINE right now ` +
			`(${offlineReason(start)}). It was kept because ${WHY_STARTED[choice.source]}. Home Assistant calls ` +
			`to it will fail until it is back. ${others} If it is a retired home, remove it in the Vome portal.`
	};
}

function appendNotice(result: CallToolResult, text: string): CallToolResult {
	return { ...result, content: [...(result.content ?? []), { type: "text" as const, text }] };
}

/**
 * Returns a proxy of ``server`` whose tools run the starting-instance check
 * once, before the first call, and carry its notice.
 *
 * Meant to sit *inside* the instance stamp (`withInstanceStamp(withStartingInstanceCheck(...))`),
 * so it runs before the stamp's `instance_id` guard: a fallback happens
 * first, and a call naming the offline home is then refused rather than
 * answered from the fallback, and the stamp names where the call really went.
 */
export function withStartingInstanceCheck(server: McpServer, ctx: ToolContext): McpServer {
	if (!ctx.instanceChoice) return server;
	let pending: Promise<Notice | null> | null = null;
	let shown = false;

	const run = (toolName: string): Promise<Notice | null> => {
		if (!pending) {
			pending = CHOOSING_TOOLS.has(toolName)
				? Promise.resolve(null)
				: checkStartingInstance(ctx).catch(() => null);
		}
		return pending;
	};

	const original = server.registerTool.bind(server);
	const wrapped = ((name: string, config: unknown, handler: unknown) => {
		const checked = async (...args: unknown[]): Promise<CallToolResult> => {
			const notice = await run(name);
			const result = await (handler as (...a: unknown[]) => Promise<CallToolResult>)(...args);
			if (!notice) return result;
			const first = !shown;
			shown = true;
			const stillOnIt =
				notice.offlineId !== undefined &&
				ctx.instances.sessionActiveId() === notice.offlineId &&
				ctx.instances.chosenId() === null;
			return first || (result.isError && stillOnIt) ? appendNotice(result, notice.text) : result;
		};
		return (original as (n: string, c: unknown, h: unknown) => unknown)(name, config, checked);
	}) as unknown as McpServer["registerTool"];

	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop === "registerTool") return wrapped;
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		}
	}) as McpServer;
}

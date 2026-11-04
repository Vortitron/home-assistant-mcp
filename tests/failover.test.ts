import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createToolContext } from "../src/context.js";
import { HaFailoverError, HaRestartingError } from "../src/ha/restClient.js";
import { createFailoverChecker, parseFailover } from "../src/vomehome/failover.js";
import { createIdentityReader, appendStamp } from "../src/tools/instanceStamp.js";

/**
 * While a CHAP standby runs a home, the main is stopped on purpose and fails
 * like a restart. Agents were told "Home Assistant is restarting" for the
 * whole failover (Nov 2026); now the error says who is running the home.
 */

const logger = createLogger("error");

/** The portal's CHAP status (portal/chap_api.py status()) with a failover on or off. */
function chapStatus(failover: boolean): Record<string, unknown> {
	return {
		instance: { id: "hosted-1", name: "GamlaBio" },
		enrolled: true,
		state: failover ? "standby_running" : "ok",
		pair: {
			kind: "local_fallback",
			main: { id: "hosted-1", name: "GamlaBio" },
			standby: { id: "rly-standby", name: "House box" },
			running: failover ? { id: "rly-standby", name: "House box" } : { id: "hosted-1", name: "GamlaBio" },
			failover,
			switching: false,
			switching_back: false
		},
		actions: failover ? ["switch_back", "switch_back_now"] : ["switch"]
	};
}

describe("reading the CHAP status", () => {
	it("finds the standby running the home", () => {
		expect(parseFailover("hosted-1", chapStatus(true))).toEqual({
			standbyId: "rly-standby",
			standbyName: "House box",
			mainId: "hosted-1"
		});
	});

	it("finds nothing when the main runs it, there is no pair, or it was asked of the standby", () => {
		expect(parseFailover("hosted-1", chapStatus(false))).toBeNull();
		expect(parseFailover("hosted-1", { instance: { id: "hosted-1" }, enrolled: false, actions: ["enrol"] })).toBeNull();
		expect(parseFailover("hosted-1", { enrolled: true, pair: null })).toBeNull();
		expect(parseFailover("rly-standby", { standby_of: { id: "hosted-1" }, actions: [] })).toBeNull();
	});

	it("follows the pair of the same home's other row (managed_on)", () => {
		const status = { ...chapStatus(true), instance: { id: "rly-twin" }, managed_on: { id: "hosted-1", name: "GamlaBio" } };
		expect(parseFailover("rly-twin", status)?.standbyId).toBe("rly-standby");
	});
});

describe("the failover check is cached", () => {
	afterEach(() => vi.useRealTimers());

	it("makes one status call for a burst, and asks again after 30 s", async () => {
		vi.useFakeTimers();
		const read = vi.fn(async () => chapStatus(true));
		const check = createFailoverChecker(read);
		const answers = await Promise.all([check("hosted-1"), check("hosted-1"), check("hosted-1")]);
		expect(answers.every((a) => a?.standbyId === "rly-standby")).toBe(true);
		expect(read).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(29_000);
		await check("hosted-1");
		expect(read).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(2_000);
		await check("hosted-1");
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("caches 'no pair' and a failed read too", async () => {
		const none = vi.fn(async () => ({ enrolled: false }));
		const noneCheck = createFailoverChecker(none);
		expect(await noneCheck("a")).toBeNull();
		expect(await noneCheck("a")).toBeNull();
		expect(none).toHaveBeenCalledTimes(1);

		const failing = vi.fn(async () => {
			throw new Error("CHAP is not available on this account yet. (status 403)");
		});
		const failingCheck = createFailoverChecker(failing);
		expect(await failingCheck("a")).toBeNull();
		expect(await failingCheck("a")).toBeNull();
		expect(failing).toHaveBeenCalledTimes(1);
	});
});

describe("a call to a stopped main says the standby runs the home", () => {
	afterEach(() => vi.unstubAllGlobals());

	/** A fake portal: the main's Home Assistant is down (502 / HTML), CHAP answers as given. */
	function portal(chap: () => Response, ha: () => Response = () => new Response("<html>502 Bad Gateway</html>", { status: 502 })) {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = String(input);
				calls.push(url);
				if (url.endsWith("/chap")) return chap();
				return ha();
			})
		);
		const config = loadConfig({
			HA_TOKEN: "",
			VOMEHOME_TOKEN: "vh_test",
			VOMEHOME_API_URL: "https://portal.test",
			VOMEHOME_INSTANCE_ID: "hosted-1",
			VOMEHOME_INSTANCES: JSON.stringify(["hosted-1", "rly-standby"])
		});
		const ctx = createToolContext(config, logger);
		return { ctx, calls, chapCalls: () => calls.filter((url) => url.endsWith("/chap")).length };
	}

	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

	it("names the standby and how to reach it, instead of 'restarting'", async () => {
		const { ctx, chapCalls } = portal(() => json(chapStatus(true)));
		const error = await ctx.rest.getStates().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HaFailoverError);
		expect(error).toBeInstanceOf(HaRestartingError);
		const message = (error as Error).message;
		expect(message).toMatch(/^CHAP failover is active: the standby 'House box' \(rly-standby\) is running this home; the main is stopped on purpose\./);
		expect(message).toContain('pass instance_id="rly-standby" (one call) or vomehome_use_instance');
		expect(message).toContain("vomehome_chap_status");
		expect(message).not.toMatch(/may need access/);
		// A burst of failing calls: one status call.
		await ctx.rest.getStates().catch(() => undefined);
		await ctx.rest.getServices().catch(() => undefined);
		expect(chapCalls()).toBe(1);
	});

	it("keeps the restart wording when no failover is active", async () => {
		const { ctx } = portal(() => json(chapStatus(false)));
		const error = await ctx.rest.getStates().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HaRestartingError);
		expect(error).not.toBeInstanceOf(HaFailoverError);
		expect((error as Error).message).toMatch(/Home Assistant is not answering/);
	});

	it("keeps the restart wording when the account has no CHAP or the status fails", async () => {
		const noChap = portal(() => json({ error: "CHAP is not available on this account yet." }, 403));
		expect(((await noChap.ctx.rest.getStates().catch((e: unknown) => e)) as Error).message).toMatch(/not answering/);
		vi.unstubAllGlobals();
		const broken = portal(() => new Response("oops", { status: 500 }));
		expect(((await broken.ctx.rest.getStates().catch((e: unknown) => e)) as Error).message).toMatch(/not answering/);
	});

	it("does not ask for a failure that is not restart-shaped", async () => {
		const { ctx, chapCalls } = portal(
			() => json(chapStatus(true)),
			() => json({ message: "Entity not found." }, 400)
		);
		const error = await ctx.rest.getStates().catch((e: unknown) => e);
		expect(error).not.toBeInstanceOf(HaRestartingError);
		expect(chapCalls()).toBe(0);
	});

	it("puts it in the stamp too", async () => {
		const { ctx } = portal(() => json(chapStatus(true)));
		const identity = await createIdentityReader(ctx)();
		const stamp = appendStamp({ content: [] }, identity).content.at(-1) as { text: string };
		expect(stamp.text).toMatch(/target=hosted-1 — CHAP failover is active: the standby 'House box' \(rly-standby\) is running this home/);
	});

	it("says when the session does not list the standby", async () => {
		const status = chapStatus(true);
		(status.pair as Record<string, unknown>).running = { id: "rly-elsewhere", name: "Other" };
		const { ctx } = portal(() => json(status));
		const error = await ctx.rest.getStates().catch((e: unknown) => e);
		expect((error as Error).message).toMatch(/may need access to it in the portal/);
	});
});

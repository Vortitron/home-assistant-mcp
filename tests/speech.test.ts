import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../src/logger.js";
import type { ToolContext } from "../src/tools/helpers.js";
import { withInstanceStamp } from "../src/tools/instanceStamp.js";
import { createInstanceManager } from "../src/vomehome/instances.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createBrokeredHaRestClient } from "../src/ha/brokeredClient.js";
import { createHaRestClient, HaApiError } from "../src/ha/restClient.js";
import { parseWav, speechContentHeader } from "../src/ha/wav.js";
import { refusesAudioFormat, registerSpeechTools } from "../src/tools/speech.js";
import { makeWav, pcmFor } from "./fixtures/wav.js";

const logger = createLogger("error");

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("parseWav", () => {
	it("reads a 16 kHz mono 16-bit WAV: rate, channels, where the sound is and how long", () => {
		const wav = parseWav(makeWav({ seconds: 2.5 }));
		expect(wav).toMatchObject({ ok: true, sampleRate: 16000, channels: 1, bitsPerSample: 16, dataOffset: 44, dataLength: 80000 });
		expect(wav.ok && wav.seconds).toBeCloseTo(2.5);
	});

	it("walks past a LIST chunk (odd-sized, padded) before the data instead of assuming byte 44", () => {
		const list = Buffer.from("INFOISFT\x07\x00\x00\x00Lavf61\x00", "binary"); // 19 bytes: one pad byte follows
		const bytes = makeWav({ rate: 48000, channels: 2, seconds: 1, extra: [{ id: "LIST", body: list }] });
		const wav = parseWav(bytes);
		expect(wav.ok).toBe(true);
		if (!wav.ok) return;
		expect(list.length).toBe(19);
		expect(wav.dataOffset).toBe(44 + 8 + 20);
		expect(wav.sampleRate).toBe(48000);
		expect(wav.channels).toBe(2);
		expect(wav.seconds).toBeCloseTo(1);
		expect(bytes.subarray(wav.dataOffset, wav.dataOffset + wav.dataLength).equals(pcmFor({ rate: 48000, channels: 2 }))).toBe(true);
	});

	it("takes the rest of the file when a streaming recorder left the data size open", () => {
		const wav = parseWav(makeWav({ seconds: 1, dataSizeField: 0xffffffff }));
		expect(wav).toMatchObject({ ok: true, dataLength: 32000 });
	});

	it("refuses 8-bit, float and anything not a WAV, saying how to convert", () => {
		const eight = parseWav(makeWav({ bits: 8 }));
		expect(eight).toMatchObject({ ok: false });
		expect(!eight.ok && eight.message).toMatch(/8-bit.*ffmpeg -i in\.wav -ar 16000 -ac 1 -sample_fmt s16 out\.wav/);

		const float = parseWav(makeWav({ format: 3, bits: 32 }));
		expect(!float.ok && float.message).toMatch(/not plain PCM \(audio format 3\)/);

		expect(parseWav(Buffer.from("ID3\x03 an mp3, really"))).toMatchObject({ ok: false, message: expect.stringMatching(/Not a WAV/) });
	});

	it("refuses more than 30 seconds", () => {
		const long = parseWav(makeWav({ seconds: 31 }));
		expect(long).toMatchObject({ ok: false });
		expect(!long.ok && long.message).toMatch(/31\.0 s long; at most 30 s/);
		expect(parseWav(makeWav({ seconds: 30 })).ok).toBe(true);
	});

	it("refuses a WAV with no sound in it", () => {
		expect(parseWav(makeWav({ seconds: 0 }))).toMatchObject({ ok: false, message: expect.stringMatching(/no sound/) });
	});
});

describe("speechToText over the broker", () => {
	const BROKER_ENV = { VOMEHOME_API_URL: "https://vome.io", VOMEHOME_TOKEN: "vh_test", VOMEHOME_INSTANCE_ID: "srv-1" };

	it("POSTs the WAV and language as JSON to /ha/stt/<entity>", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ text: "Tänd lampan i vardagsrummet.", result: "success" }));
		vi.stubGlobal("fetch", fetchMock);
		const wav = makeWav().toString("base64");

		const answer = await createBrokeredHaRestClient(loadConfig(BROKER_ENV), logger).speechToText("stt.vome_hearing", wav, "sv");

		expect(answer).toEqual({ text: "Tänd lampan i vardagsrummet.", result: "success" });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://vome.io/api/v1/instances/srv-1/ha/stt/stt.vome_hearing");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({ Authorization: "Bearer vh_test", "Content-Type": "application/json" });
		expect(JSON.parse(init.body as string)).toEqual({ audio_base64: wav, language: "sv" });
	});

	it("waits 45 s for the engine, not the default 15", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						signal = init.signal ?? undefined;
						signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
					})
			)
		);
		const pending = createBrokeredHaRestClient(loadConfig(BROKER_ENV), logger).speechToText("stt.x", "UklGRg==", "en");
		const settled = pending.catch((error: unknown) => error);

		await vi.advanceTimersByTimeAsync(44_000);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(signal?.aborted).toBe(true);
		expect(String(await settled)).toMatch(/timed out after 45000ms/);
	});
});

describe("speechToText on a direct connection", () => {
	function client() {
		return createHaRestClient(loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "tok" }), logger);
	}

	it("sends Home Assistant the bare PCM, with what the WAV header said in X-Speech-Content", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ text: "Turn on the kitchen light.", result: "success" }));
		vi.stubGlobal("fetch", fetchMock);
		const list = Buffer.from("INFOISFT\x05\x00\x00\x00Lavf\x00\x00", "binary");
		const spec = { rate: 22050, channels: 2, seconds: 0.5, extra: [{ id: "LIST", body: list }] };

		const answer = await client().speechToText("stt.faster_whisper", makeWav(spec).toString("base64"), "en-GB");

		expect(answer.text).toBe("Turn on the kitchen light.");
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://ha.local:8123/api/stt/stt.faster_whisper");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			Authorization: "Bearer tok",
			"Content-Type": "audio/wav",
			"X-Speech-Content": "format=wav; codec=pcm; sample_rate=22050; bit_rate=16; channel=2; language=en-GB"
		});
		const body = Buffer.from(init.body as Uint8Array);
		expect(body.length).toBe(pcmFor(spec).length);
		expect(body.equals(pcmFor(spec))).toBe(true);
	});

	it("names all six fields Home Assistant requires in the header", () => {
		const header = speechContentHeader({ sampleRate: 16000, channels: 1 }, "sv");
		const fields = Object.fromEntries(header.split(";").map((part) => part.trim().split("=")));
		expect(fields).toEqual({ format: "wav", codec: "pcm", sample_rate: "16000", bit_rate: "16", channel: "1", language: "sv" });
	});

	it("refuses a WAV it cannot read without calling Home Assistant", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(client().speechToText("stt.x", makeWav({ bits: 8 }).toString("base64"), "en")).rejects.toThrow(/8-bit/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps Home Assistant's 415 recognisable as a format refusal", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("415: Unsupported Media Type", { status: 415, statusText: "Unsupported Media Type" })));
		const error = await client()
			.speechToText("stt.x", makeWav({ rate: 44100 }).toString("base64"), "en")
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HaApiError);
		expect(refusesAudioFormat(error)).toBe(true);
	});
});

describe("refusesAudioFormat", () => {
	it("knows the portal relaying a 415 as a 502", () => {
		expect(refusesAudioFormat(new HaApiError("VomeHome broker POST /stt/stt.x responded 502: Home Assistant answered 415.", 502, ""))).toBe(true);
		expect(refusesAudioFormat(new HaApiError("VomeHome broker POST /stt/stt.x responded 502: Home Assistant answered 500.", 502, ""))).toBe(false);
		expect(refusesAudioFormat(new HaApiError("VomeHome broker POST /stt/stt.mic_415 responded 404: no", 404, ""))).toBe(false);
	});
});

describe("ha_speech_to_text routed by instance_id", () => {
	/* The tool declares no instance_id of its own, so withInstanceStamp adds the
	   optional one: a call naming another home goes there, through the
	   instance manager's forwarding of speechToText. */
	const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

	function harness() {
		const config = loadConfig({
			HA_TOKEN: "",
			VOMEHOME_TOKEN: "vh_test",
			VOMEHOME_API_URL: "https://portal.test",
			VOMEHOME_INSTANCE_ID: "rly-1",
			VOMEHOME_INSTANCES: JSON.stringify([
				{ id: "rly-1", write: true, config: true },
				{ id: "rly-2", write: true, config: false },
				{ id: "rly-3", write: false, config: false }
			])
		});
		const instances = createInstanceManager(config, quiet);
		const ctx = { config, logger: quiet, instances, rest: instances.rest } as unknown as ToolContext;
		const registered = new Map<string, { config: any; handler: (...a: any[]) => Promise<CallToolResult> }>();
		const fake = {
			registerTool: (name: string, cfg: unknown, handler: any) => registered.set(name, { config: cfg, handler })
		} as unknown as McpServer;
		registerSpeechTools(withInstanceStamp(fake, ctx), ctx);
		const calls: Array<{ url: string; body?: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), body: init?.body as string | undefined });
				if (String(url).includes("/ha/stt/")) return jsonResponse({ text: "Hej.", result: "success" });
				return jsonResponse({ language: "sv", location_name: "Standby" });
			})
		);
		const call = (args: Record<string, unknown>) => registered.get("ha_speech_to_text")!.handler(args, {});
		return { registered, calls, call };
	}

	it("gets the optional instance_id and sends the audio to the named home", async () => {
		const { registered, calls, call } = harness();
		expect(registered.get("ha_speech_to_text")!.config.inputSchema).toHaveProperty("instance_id");

		const result = await call({ entity_id: "stt.vome_hearing", audio_base64: makeWav().toString("base64"), instance_id: "rly-2" });

		expect(result.isError).toBeFalsy();
		expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ text: "Hej.", language: "sv" });
		const stt = calls.find((c) => c.url.includes("/stt/"))!;
		expect(stt.url).toBe("https://portal.test/api/v1/instances/rly-2/ha/stt/stt.vome_hearing");
		expect(JSON.parse(stt.body!).language).toBe("sv");
		expect(calls.every((c) => c.url.includes("/instances/rly-2/"))).toBe(true);
	});

	it("is refused on a home whose key has no write, before any audio is sent", async () => {
		const { calls, call } = harness();
		const result = await call({ entity_id: "stt.vome_hearing", audio_base64: makeWav().toString("base64"), instance_id: "rly-3" });
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toMatch(/Refused: Writes are disabled/);
		expect(calls.some((c) => c.url.includes("/stt/"))).toBe(false);
	});
});

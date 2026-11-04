import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HaApiError } from "../ha/restClient.js";
import { FFMPEG_HINT, STT_LANGUAGE_RE, STT_MAX_SECONDS, STT_PREFERRED_RATE, parseWav } from "../ha/wav.js";
import { evaluateDomainWrite } from "../safety.js";
import { MAX_UPLOAD_BYTES, resolveLocalPath } from "./configFiles.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Speech to text: a WAV in, the words a Home Assistant speech-to-text engine
 * (stt.*) hears out. What a voice satellite does with its microphone, so an
 * agent can test an assistant's hearing (a new engine, a language, a noisy
 * room) without standing in front of one.
 *
 * A write, not a read: an engine such as Vome Hearing or a cloud one is paid
 * for per request. Gated like a service call, and through VomeHome it needs
 * ha:write.
 */

/** The most audio one call takes: the same 2 MiB as a file upload (30 s of 16 kHz mono is under 1 MiB). */
export const MAX_AUDIO_BYTES = MAX_UPLOAD_BYTES;

const ENTITY_RE = /^stt\.[a-z0-9_]+$/;

type Audio = { ok: true; bytes: Buffer; from?: string } | { ok: false; message: string };

/** What the hosted server says to audio_path: it is Vome's disk, so it is never read. */
export function hostedAudioPathMessage(audioPath: string): string {
	return [
		"Nothing sent: this is the hosted Vome MCP. It runs on Vome's servers, so it cannot see files on your " +
			"machine, and audio_path would be read from the server's own disk.",
		"",
		"Pass the recording as audio_base64 instead: the WAV file's bytes, base64-encoded, for example from",
		"",
		`  base64 -w0 "${audioPath}"`,
		"",
		`(on macOS: base64 -i "${audioPath}"). At most 2 MiB and ${STT_MAX_SECONDS} s of 16-bit PCM.`
	].join("\n");
}

async function readAudioPath(audioPath: string): Promise<Audio> {
	const resolved = resolveLocalPath(audioPath);
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(resolved);
	} catch (error) {
		const code = (error as { code?: string }).code;
		return {
			ok: false,
			message:
				code === "ENOENT"
					? `Nothing sent: ${resolved} does not exist (audio_path is resolved against ${process.cwd()}).`
					: `Nothing sent: could not read ${resolved} (${code ?? String(error)}).`
		};
	}
	if (!info.isFile()) {
		return { ok: false, message: `Nothing sent: ${resolved} is not a regular file.` };
	}
	if (info.size > MAX_AUDIO_BYTES) {
		return { ok: false, message: tooBig(`${resolved} is ${info.size} bytes`) };
	}
	const bytes = await readFile(resolved);
	if (bytes.length > MAX_AUDIO_BYTES) {
		return { ok: false, message: tooBig(`${resolved} is ${bytes.length} bytes`) };
	}
	return { ok: true, bytes, from: resolved };
}

function decodeAudioBase64(value: string): Audio {
	// A data: URL is taken too; whitespace (a wrapped base64) is ignored.
	const cleaned = value.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
	if (cleaned.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) {
		return { ok: false, message: tooBig(`audio_base64 is ${cleaned.length} characters`) };
	}
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
		return { ok: false, message: "Nothing sent: audio_base64 is not base64." };
	}
	return { ok: true, bytes: Buffer.from(cleaned, "base64") };
}

function tooBig(what: string): string {
	return (
		`Nothing sent: ${what}, over the ${MAX_AUDIO_BYTES}-byte (2 MiB) limit. ` +
		`${STT_MAX_SECONDS} s of 16 kHz mono 16-bit audio is under 1 MiB: ` +
		"ffmpeg -i in.wav -ar 16000 -ac 1 -sample_fmt s16 -t 30 out.wav"
	);
}

/** Home Assistant refusing the audio's format: a 415 directly, or the portal relaying one. */
export function refusesAudioFormat(error: unknown): boolean {
	if (!(error instanceof HaApiError)) return false;
	return error.status === 415 || /(?:answered|responded) 415\b|Unsupported Media Type/i.test(`${error.message}\n${error.body}`);
}

/** The home's own language (/api/config `language`), or "en" when it says none or cannot be read. */
async function homeLanguage(ctx: ToolContext): Promise<string> {
	try {
		const language = (await ctx.rest.getConfig()).language;
		if (typeof language === "string" && STT_LANGUAGE_RE.test(language)) {
			return language;
		}
	} catch (error) {
		ctx.logger.debug(`Could not read the home's language: ${String(error)}`);
	}
	return "en";
}

export function registerSpeechTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_speech_to_text",
		{
			title: "Speech to text",
			description:
				"Run a recording through one of Home Assistant's speech-to-text engines (an stt.* entity, as a voice " +
				"assistant does with its microphone) and get back the words it heard: to test an assistant's hearing, " +
				"a language or an engine without speaking to a device. Takes a WAV of 16-bit PCM, at most " +
				`${STT_MAX_SECONDS} s and 2 MiB. Engines want 16 kHz mono; other rates are sent as they are, and if the ` +
				"engine refuses them, convert with: ffmpeg -i in.wav -ar 16000 -ac 1 -sample_fmt s16 out.wav\n\n" +
				"Give the recording as audio_path (a file on the machine the MCP server runs on: local npx / stdio " +
				"servers only) or audio_base64 (the WAV's bytes in base64: the way to send it to the hosted Vome MCP, " +
				"which cannot see your files). Exactly one.\n\n" +
				"Counts as a write: some engines (Vome Hearing, cloud ones) charge per request. Refused unless writes " +
				"are enabled; through VomeHome the API key needs ha:write. Homes Vome reaches directly (external) " +
				"cannot take audio. List engines with ha_list_entities domain=stt.",
			inputSchema: {
				entity_id: z.string().describe("The speech-to-text engine, e.g. 'stt.home_assistant_cloud' or 'stt.faster_whisper'."),
				audio_path: z
					.string()
					.min(1)
					.optional()
					.describe(
						"A WAV file on the MCP server's machine: absolute, '~/...', or relative to its working directory. " +
							"Not on the hosted Vome MCP (use audio_base64)."
					),
				audio_base64: z
					.string()
					.min(1)
					.optional()
					.describe("The WAV file's bytes, base64-encoded (a data: URL is accepted)."),
				language: z
					.string()
					.optional()
					.describe("Language spoken, e.g. 'sv', 'en-GB'. Default: the home's own language, else 'en'.")
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
		},
		async ({ entity_id, audio_path, audio_base64, language }) =>
			runTool(ctx.logger, "ha_speech_to_text", async () => {
				if (!ENTITY_RE.test(entity_id)) {
					return errorResult(
						`'${entity_id}' is not a speech-to-text engine (stt.something). List them with ha_list_entities domain=stt.`
					);
				}
				if ((audio_path === undefined) === (audio_base64 === undefined)) {
					return errorResult("Give exactly one of audio_path (a local WAV file) or audio_base64 (the WAV's bytes in base64).");
				}
				if (language !== undefined && !STT_LANGUAGE_RE.test(language)) {
					return errorResult(`language must be a code such as en, en-GB or sv, not '${language}'.`);
				}
				// Paid per request on some engines: gated like a service call.
				const decision = evaluateDomainWrite("stt", ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				let audio: Audio;
				if (audio_path !== undefined) {
					// On the hosted server "local" is Vome's disk. Never read it.
					if (ctx.config.hosted) {
						return errorResult(hostedAudioPathMessage(audio_path));
					}
					audio = await readAudioPath(audio_path);
				} else {
					audio = decodeAudioBase64(audio_base64 as string);
				}
				if (!audio.ok) {
					return errorResult(audio.message);
				}
				const wav = parseWav(audio.bytes);
				if (!wav.ok) {
					return errorResult(`Nothing sent: ${wav.message}`);
				}
				const lang = language ?? (await homeLanguage(ctx));
				let answer;
				try {
					answer = await ctx.rest.speechToText(entity_id, audio.bytes.toString("base64"), lang);
				} catch (error) {
					if (refusesAudioFormat(error)) {
						return errorResult(
							`${entity_id} refused ${wav.sampleRate} Hz, ${wav.channels}-channel audio in '${lang}'. ${FFMPEG_HINT} ` +
								"If the format is already that, the engine may not support the language: check its " +
								"supported languages (ha_get_state)."
						);
					}
					if (error instanceof HaApiError && error.status === 404) {
						return errorResult(
							`No speech-to-text engine ${entity_id} on this home. List them with ha_list_entities domain=stt.`
						);
					}
					throw error;
				}
				const unusual = wav.sampleRate !== STT_PREFERRED_RATE || wav.channels !== 1;
				const facts = {
					entity_id,
					language: lang,
					seconds: Math.round(wav.seconds * 100) / 100,
					sample_rate: wav.sampleRate,
					channels: wav.channels,
					...(audio.from ? { audio_path: audio.from } : {})
				};
				if (!answer || answer.result !== "success") {
					return errorResult(
						`${entity_id} did not make out any words (result: ${String(answer?.result ?? "none")}). ` +
							`Home Assistant answered: ${JSON.stringify(answer ?? null)}. ` +
							(unusual ? `${FFMPEG_HINT} ` : "") +
							`Sent: ${JSON.stringify(facts)}`
					);
				}
				return jsonResult({
					text: answer.text ?? "",
					result: answer.result,
					...facts,
					...(unusual
						? {
								note:
									`Sent as recorded (${wav.sampleRate} Hz, ${wav.channels} channel${wav.channels === 1 ? "" : "s"}); ` +
									"most engines expect 16 kHz mono, so if the words look wrong convert first: " +
									"ffmpeg -i in.wav -ar 16000 -ac 1 -sample_fmt s16 out.wav"
							}
						: {})
				});
			})
	);
}

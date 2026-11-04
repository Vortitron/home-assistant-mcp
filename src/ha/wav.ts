/**
 * Reading a WAV file's header, for speech to text.
 *
 * Home Assistant's speech-to-text engines take bare PCM plus a header line
 * (X-Speech-Content) saying what it is, the way a voice satellite streams
 * it. So the WAV is read only as far as its chunks: `fmt ` says the format,
 * `data` is the sound. Nothing is decoded.
 *
 * The chunks are walked rather than the data assumed at byte 44: many tools
 * write a LIST (metadata) or fact chunk first, and some write a longer
 * `fmt `.
 */

/** The longest recording the portal (and this server) sends to an engine. */
export const STT_MAX_SECONDS = 30;

/** What engines want, and what the tool says to convert to. */
export const STT_PREFERRED_RATE = 16000;

export const FFMPEG_HINT =
	"This engine takes 16 kHz mono 16-bit WAV. Convert with: ffmpeg -i in.wav -ar 16000 -ac 1 -sample_fmt s16 out.wav";

export interface WavInfo {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	/** Where the PCM starts in the file. */
	dataOffset: number;
	/** PCM bytes, whole frames only. */
	dataLength: number;
	seconds: number;
}

export type WavParse = ({ ok: true } & WavInfo) | { ok: false; message: string };

function fourcc(bytes: Uint8Array, offset: number): string {
	return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/**
 * The header of a 16-bit PCM WAV, or why it cannot be sent: not a WAV, not
 * PCM, not 16-bit, no sound, or longer than {@link STT_MAX_SECONDS}.
 */
export function parseWav(bytes: Uint8Array): WavParse {
	const fail = (message: string): WavParse => ({ ok: false, message });
	if (bytes.length < 12 || fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WAVE") {
		return fail("Not a WAV file (no RIFF/WAVE header).");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
	let data: { offset: number; length: number } | null = null;
	let offset = 12;
	while (offset + 8 <= bytes.length && !(fmt && data)) {
		const id = fourcc(bytes, offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === "fmt ") {
			if (size < 16 || body + 16 > bytes.length) {
				return fail("The WAV's fmt chunk is too short.");
			}
			fmt = {
				format: view.getUint16(body, true),
				channels: view.getUint16(body + 2, true),
				sampleRate: view.getUint32(body + 4, true),
				bits: view.getUint16(body + 14, true)
			};
		} else if (id === "data") {
			// A recorder that was streaming may leave the size at 0 or
			// 0xFFFFFFFF: the sound is then whatever follows.
			const rest = bytes.length - body;
			data = { offset: body, length: size === 0 || size > rest ? rest : size };
		}
		// Chunks are padded to an even length.
		offset = body + size + (size % 2);
	}
	if (!fmt) {
		return fail("The WAV has no fmt chunk, so its format is unknown.");
	}
	if (fmt.format !== 1) {
		return fail(
			`The WAV is not plain PCM (audio format ${fmt.format}${fmt.format === 0xfffe ? ", WAVE_FORMAT_EXTENSIBLE" : ""}). ` +
				FFMPEG_HINT
		);
	}
	if (fmt.bits !== 16) {
		return fail(`The WAV is ${fmt.bits}-bit; speech to text takes 16-bit PCM. ${FFMPEG_HINT}`);
	}
	if (fmt.channels < 1 || fmt.sampleRate < 1) {
		return fail("The WAV's fmt chunk gives no channels or no sample rate.");
	}
	if (!data) {
		return fail("The WAV has no data chunk.");
	}
	const frame = fmt.channels * 2;
	const length = data.length - (data.length % frame);
	if (length <= 0) {
		return fail("The WAV holds no sound (its data chunk is empty).");
	}
	const seconds = length / (fmt.sampleRate * frame);
	if (seconds > STT_MAX_SECONDS) {
		return fail(
			`The recording is ${seconds.toFixed(1)} s long; at most ${STT_MAX_SECONDS} s goes to a speech-to-text engine. ` +
				"Trim it (ffmpeg -i in.wav -t 30 out.wav)."
		);
	}
	return {
		ok: true,
		sampleRate: fmt.sampleRate,
		channels: fmt.channels,
		bitsPerSample: fmt.bits,
		dataOffset: data.offset,
		dataLength: length,
		seconds
	};
}

/** The X-Speech-Content header Home Assistant's /api/stt/<entity> reads its metadata from. */
export function speechContentHeader(info: Pick<WavInfo, "sampleRate" | "channels">, language: string): string {
	return `format=wav; codec=pcm; sample_rate=${info.sampleRate}; bit_rate=16; channel=${info.channels}; language=${language}`;
}

/** Language codes as the portal accepts them (en, en-GB, sv, zh-Hans); keeps the header free of `;`. */
export const STT_LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

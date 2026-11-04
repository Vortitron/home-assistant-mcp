/** Builds WAV files for the speech-to-text tests. */

export interface WavSpec {
	rate?: number;
	channels?: number;
	bits?: number;
	/** WAVE audio format: 1 is PCM, 3 IEEE float. */
	format?: number;
	seconds?: number;
	/** Chunks written between fmt and data, e.g. a LIST of metadata. */
	extra?: Array<{ id: string; body: Buffer }>;
	/** Overrides the data chunk's size field (a streaming recorder leaves 0 or 0xFFFFFFFF). */
	dataSizeField?: number;
}

function chunk(id: string, body: Buffer, sizeField = body.length): Buffer {
	const head = Buffer.alloc(8);
	head.write(id, 0, "ascii");
	head.writeUInt32LE(sizeField, 4);
	return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** The PCM a WAV built by {@link makeWav} carries: a sawtooth, so every byte is checkable. */
export function pcmFor(spec: WavSpec = {}): Buffer {
	const rate = spec.rate ?? 16000;
	const channels = spec.channels ?? 1;
	const bytesPerSample = (spec.bits ?? 16) / 8;
	const length = Math.round((spec.seconds ?? 1) * rate) * channels * bytesPerSample;
	const pcm = Buffer.alloc(length);
	for (let i = 0; i < length; i++) pcm[i] = i % 251;
	return pcm;
}

export function makeWav(spec: WavSpec = {}): Buffer {
	const rate = spec.rate ?? 16000;
	const channels = spec.channels ?? 1;
	const bits = spec.bits ?? 16;
	const fmt = Buffer.alloc(16);
	fmt.writeUInt16LE(spec.format ?? 1, 0);
	fmt.writeUInt16LE(channels, 2);
	fmt.writeUInt32LE(rate, 4);
	fmt.writeUInt32LE((rate * channels * bits) / 8, 8);
	fmt.writeUInt16LE((channels * bits) / 8, 12);
	fmt.writeUInt16LE(bits, 14);
	const pcm = pcmFor(spec);
	const body = Buffer.concat([
		Buffer.from("WAVE", "ascii"),
		chunk("fmt ", fmt),
		...(spec.extra ?? []).map((extra) => chunk(extra.id, extra.body)),
		chunk("data", pcm, spec.dataSizeField ?? pcm.length)
	]);
	return chunk("RIFF", body);
}

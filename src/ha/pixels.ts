/**
 * A picture as a small grid of pixels, for a client that draws in text.
 *
 * A terminal pane cannot show a JPEG, but it can show colour: two pixels a
 * character cell with a half block (top colour on bottom colour). So a camera
 * still is decoded here and shrunk to the cells it will fill, and the client
 * gets a few kilobytes of RGB instead of a 200 KB image it could not read.
 */
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

export interface Pixels {
	width: number;
	height: number;
	/** RGB, 3 bytes a pixel, row by row. */
	rgb: Buffer;
}

/** Decode a JPEG or PNG (base64) to RGBA. */
export function decodeImage(base64: string, mimeType: string): { width: number; height: number; rgba: Uint8Array } {
	const bytes = Buffer.from(base64, "base64");
	const isPng = mimeType.includes("png") || bytes.subarray(0, 4).toString("hex") === "89504e47";
	if (isPng) {
		const png = PNG.sync.read(bytes);
		return { width: png.width, height: png.height, rgba: png.data };
	}
	const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256, formatAsRGBA: true });
	return { width: decoded.width, height: decoded.height, rgba: decoded.data };
}

/**
 * Shrink to fit `width` x `height`, keeping the aspect ratio, each new pixel the
 * average of the source pixels under it (a box filter: no shimmer, cheap).
 */
export function shrink(image: { width: number; height: number; rgba: Uint8Array }, width: number, height: number): Pixels {
	const scale = Math.min(width / image.width, height / image.height, 1);
	const w = Math.max(1, Math.round(image.width * scale));
	const h = Math.max(1, Math.round(image.height * scale));
	const rgb = Buffer.alloc(w * h * 3);
	for (let y = 0; y < h; y++) {
		const y0 = Math.floor((y * image.height) / h);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / h));
		for (let x = 0; x < w; x++) {
			const x0 = Math.floor((x * image.width) / w);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / w));
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) {
					const i = (sy * image.width + sx) * 4;
					r += image.rgba[i] ?? 0;
					g += image.rgba[i + 1] ?? 0;
					b += image.rgba[i + 2] ?? 0;
					n++;
				}
			}
			const o = (y * w + x) * 3;
			rgb[o] = Math.round(r / n);
			rgb[o + 1] = Math.round(g / n);
			rgb[o + 2] = Math.round(b / n);
		}
	}
	return { width: w, height: h, rgb };
}

/**
 * A history series as at most `max` points: numbers averaged per time bucket,
 * anything else as the state each bucket ended on. A day of a sensor that
 * reports every 20 s is 4,000 points and hundreds of kilobytes; a chart a pane
 * wide needs a hundred.
 */
export function downsample(
	states: Array<{ state: string; last_changed?: string; last_updated?: string }>,
	max: number
): Array<[string, number | string]> {
	const points = states
		.map((s) => ({ at: s.last_changed ?? s.last_updated ?? "", value: s.state }))
		.filter((p) => p.at !== "");
	if (points.length <= max) return points.map((p) => [p.at, toValue(p.value)]);
	const out: Array<[string, number | string]> = [];
	const size = points.length / max;
	for (let k = 0; k < max; k++) {
		const bucket = points.slice(Math.floor(k * size), Math.max(Math.floor(k * size) + 1, Math.floor((k + 1) * size)));
		const numbers = bucket.map((p) => Number(p.value)).filter((n, i) => Number.isFinite(n) && bucket[i]!.value.trim() !== "");
		const last = bucket[bucket.length - 1]!;
		out.push([last.at, numbers.length === bucket.length ? round(numbers.reduce((a, b) => a + b, 0) / numbers.length) : last.value]);
	}
	return out;
}

function toValue(state: string): number | string {
	const n = Number(state);
	return state.trim() !== "" && Number.isFinite(n) ? n : state;
}

function round(n: number): number {
	return Math.round(n * 1000) / 1000;
}

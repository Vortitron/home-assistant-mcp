import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { decodeImage, downsample, shrink } from "../src/ha/pixels.js";

function solidJpeg(width: number, height: number, rgb: [number, number, number]): string {
	const data = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
	return jpeg.encode({ data, width, height }, 95).data.toString("base64");
}

describe("pixels for a text client", () => {
	it("decodes a JPEG and shrinks it to fit, keeping its shape and colour", () => {
		const frame = shrink(decodeImage(solidJpeg(320, 180, [200, 40, 40]), "image/jpeg"), 64, 64);
		expect([frame.width, frame.height]).toEqual([64, 36]);
		expect(frame.rgb.length).toBe(64 * 36 * 3);
		expect(Math.abs(frame.rgb[0]! - 200)).toBeLessThan(8);
		expect(Math.abs(frame.rgb[1]! - 40)).toBeLessThan(8);
	});

	it("decodes a PNG too", () => {
		const png = new PNG({ width: 4, height: 2 });
		png.data.fill(255);
		const frame = shrink(decodeImage(PNG.sync.write(png).toString("base64"), "image/png"), 4, 4);
		expect([frame.width, frame.height, frame.rgb[0]]).toEqual([4, 2, 255]);
	});

	it("downsamples a long series: numbers averaged per bucket, other states as each bucket's last", () => {
		const numbers = Array.from({ length: 1000 }, (_, i) => ({ state: String(i % 2 === 0 ? 20 : 22), last_changed: `t${i}` }));
		const points = downsample(numbers, 50);
		expect(points.length).toBe(50);
		expect(points.every(([, v]) => v === 21)).toBe(true);
		const modes = downsample([{ state: "sleep", last_changed: "a" }, { state: "walk", last_changed: "b" }, { state: "forage", last_changed: "c" }], 2);
		expect(modes.map(([, v]) => v)).toEqual(["sleep", "forage"]);
	});
});

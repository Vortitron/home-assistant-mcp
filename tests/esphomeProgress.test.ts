import { describe, expect, it } from "vitest";
import { buildProgressFor, type ProgressExtra } from "../src/esphome/progress.js";

function fakeExtra(token: string | number | undefined) {
	const sent: { progress: number; message?: string }[] = [];
	const extra: ProgressExtra = {
		...(token === undefined ? {} : { _meta: { progressToken: token } }),
		sendNotification: async (n) => {
			sent.push({ progress: n.params.progress, message: n.params.message });
		}
	};
	return { extra, sent };
}

describe("buildProgressFor", () => {
	it("sends at once, then holds back while output streams, and keeps a heartbeat when it does not", () => {
		let clock = 0;
		const { extra, sent } = fakeExtra("tok-1");
		const progress = buildProgressFor(extra, () => clock)!;
		progress(3, "\\033[32mINFO Reading configuration\\033[0m");
		clock = 4_000;
		progress(9, "[12/900] Building C object");
		clock = 12_000;
		progress(40, "[200/900] Building C object");
		clock = 30_000;
		progress(40, null); // nothing new: only the heartbeat may send
		clock = 43_000;
		progress(40, null);
		expect(sent.map((s) => s.progress)).toEqual([3, 40, 40]);
		expect(sent[0]?.message).toBe("INFO Reading configuration");
	});

	it("sends nothing when the client did not ask for progress", () => {
		expect(buildProgressFor(fakeExtra(undefined).extra)).toBeUndefined();
		expect(buildProgressFor(undefined)).toBeUndefined();
	});
});

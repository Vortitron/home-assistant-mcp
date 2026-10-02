import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createEsphomeActivityLog } from "../src/esphome/activity.js";
import { createBrokeredEsphomeDashboardClient } from "../src/esphome/brokeredDashboardClient.js";

const logger = createLogger("error");

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ESPHome activity log", () => {
	it("hands a reader only the lines newer than what it last saw", () => {
		const log = createEsphomeActivityLog();
		log.begin("job-1", "compile", "lr.yaml");
		log.addLines("job-1", ["Compiling a\n", "Compiling b\n"]);
		const first = log.snapshot();
		expect(first.jobs[0]?.lines).toEqual(["Compiling a\n", "Compiling b\n"]);

		log.addLines("job-1", ["Linking\n"]);
		const second = log.snapshot(first.seq);
		expect(second.jobs[0]?.lines).toEqual(["Linking\n"]);
		expect(second.jobs[0]?.line_count).toBe(3);
		expect(second.jobs[0]?.done).toBe(false);
	});

	it("records how a job ended, and forgets finished jobs after a while", () => {
		let clock = 0;
		const log = createEsphomeActivityLog(() => clock);
		log.begin("job-1", "upload", "lr.yaml");
		log.finish("job-1", { exitCode: 0 });
		expect(log.snapshot().jobs[0]).toMatchObject({ done: true, exit_code: 0, error: null });

		clock = 11 * 60 * 1000;
		expect(log.snapshot().jobs).toEqual([]);
	});

	it("keeps a bounded number of lines per job", () => {
		const log = createEsphomeActivityLog();
		log.begin("job-1", "compile", "lr.yaml");
		log.addLines("job-1", Array.from({ length: 1000 }, (_, i) => `line ${i}\n`));
		const job = log.snapshot().jobs[0]!;
		expect(job.line_count).toBe(1000);
		expect(job.lines.length).toBe(400);
		expect(job.lines.at(-1)).toBe("line 999\n");
	});
});

describe("brokered ESPHome builds report their progress while they run", () => {
	it("shows a running compile's output before the compile returns", async () => {
		// The second poll is held open until the test has looked at the activity:
		// the point is that a watcher sees lines while the build is still going.
		let release: (value: Response) => void = () => undefined;
		const held = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ job_id: "job-1" }))
			.mockResolvedValueOnce(jsonResponse({ lines: ["Compiling src/main.cpp.o\n"], cursor: 1, done: false }))
			.mockReturnValueOnce(held);
		vi.stubGlobal("fetch", fetchMock);

		const client = createBrokeredEsphomeDashboardClient(
			loadConfig({ VOMEHOME_API_URL: "https://vome.io", VOMEHOME_TOKEN: "vh_test", VOMEHOME_INSTANCE_ID: "rly-1" }),
			logger,
			() => "rly-1"
		);
		const running = client.runCommand({ command: "compile", configuration: "lr.yaml" });

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 5000 });
		const during = client.activity();
		expect(during.jobs[0]).toMatchObject({ job_id: "job-1", command: "compile", configuration: "lr.yaml", done: false });
		expect(during.jobs[0]?.lines).toEqual(["Compiling src/main.cpp.o\n"]);

		release(jsonResponse({ lines: ["Linking\n"], cursor: 2, done: true, exit_code: 0 }));
		const result = await running;
		expect(result.exitCode).toBe(0);
		const after = client.activity(during.seq);
		expect(after.jobs[0]).toMatchObject({ done: true, exit_code: 0 });
		expect(after.jobs[0]?.lines).toEqual(["Linking\n"]);
	});

	it("records a failed job's error", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ job_id: "job-2" }))
				.mockResolvedValueOnce(jsonResponse({ lines: [], cursor: 0, done: true, error: "device unreachable" }))
		);
		const client = createBrokeredEsphomeDashboardClient(
			loadConfig({ VOMEHOME_API_URL: "https://vome.io", VOMEHOME_TOKEN: "vh_test", VOMEHOME_INSTANCE_ID: "rly-1" }),
			logger,
			() => "rly-1"
		);
		await expect(client.runCommand({ command: "upload", configuration: "lr.yaml" })).rejects.toThrow("device unreachable");
		expect(client.activity().jobs[0]).toMatchObject({ done: true, exit_code: null });
		expect(client.activity().jobs[0]?.error).toContain("device unreachable");
	});
});

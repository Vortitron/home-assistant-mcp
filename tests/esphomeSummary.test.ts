import { describe, expect, it } from "vitest";
import { summariseOutput } from "../src/esphome/summary.js";

function compileOutput(files: number, extra: string[] = []): string {
	return [
		"INFO Reading configuration /config/esphome/lr.yaml...",
		...Array.from({ length: files }, (_, i) => `Compiling .pioenvs/lr/src/file${i}.cpp.o`),
		...extra,
		"Linking .pioenvs/lr/firmware.elf",
		"RAM:   [=         ]  11.2% (used 36700 bytes from 327680 bytes)",
		"Flash: [=====     ]  52.1% (used 956000 bytes from 1835008 bytes)",
		"INFO Successfully compiled program.",
		""
	].join("\n");
}

describe("summariseOutput", () => {
	it("keeps every error and warning, the memory use and the end, and says what it left out", () => {
		const output = compileOutput(400, [
			"src/main.cpp:12:5: warning: unused variable 'x'",
			"src/esphome/foo.cpp:3:1: error: expected ';' before '}'"
		]);
		const summary = summariseOutput(output, 60);
		expect(summary.summarised).toBe(true);
		expect(summary.total_lines).toBe(407);
		expect(summary.output).toContain("warning: unused variable 'x'");
		expect(summary.output).toContain("error: expected ';' before '}'");
		expect(summary.output).toContain("Successfully compiled program");
		expect(summary.output).toMatch(/\d+ earlier lines left out \(full_output: true returns them\)/);
		expect(summary.output.split("\n").length).toBeLessThan(80);
	});

	it("returns short output whole", () => {
		const output = compileOutput(20);
		expect(summariseOutput(output, 60)).toEqual({ output, total_lines: 25, summarised: false });
	});

	it("does not count a clean '0 errors' line as an error", () => {
		const output = compileOutput(300, ["INFO Done, 0 errors"]);
		expect(summariseOutput(output, 60).output).not.toContain("── errors and warnings ──");
	});

	it("reads colour codes the stream sends as text", () => {
		// What the dashboard really sends: `\\033[32m` as characters, not an escape.
		const output = compileOutput(300, ["\\033[33mWARNING something is deprecated\\033[0m"]);
		const summary = summariseOutput(output, 60).output;
		expect(summary).toContain("WARNING something is deprecated");
		expect(summary).not.toContain("\\033");
	});
});

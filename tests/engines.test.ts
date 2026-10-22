import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import semver from "semver";

// package.json promised Node >= 18.18 long after the dependencies stopped
// running there: the MCP SDK's Streamable HTTP server calls the global
// `crypto` (Node 19+) and @hono/node-server declares >= 20. A Node 18
// user got "crypto is not defined" on every request instead of an install
// warning, and CI on Node 18 went red (Oct 2026) for the same reason.

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

describe("engines.node", () => {
	const floor = semver.minVersion(read("package.json").engines.node)!.version;

	it("is high enough for every runtime dependency that runs on this platform", () => {
		const lock = read("package-lock.json");
		const refused = Object.entries<{ dev?: boolean; os?: string[]; engines?: { node?: string } }>(lock.packages)
			.filter(([name, meta]) => name && !meta.dev && meta.engines?.node)
			.filter(([, meta]) => !meta.os || meta.os.includes(process.platform))
			.filter(([, meta]) => semver.validRange(meta.engines!.node!) && !semver.satisfies(floor, meta.engines!.node!))
			.map(([name, meta]) => `${name.replace(/^.*node_modules\//, "")} needs node ${meta.engines!.node}`);
		expect(refused).toEqual([]);
	});

	it("is the one the README tells people", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		expect(readme).toContain(`Node.js ≥ ${semver.major(floor)}`);
	});
});

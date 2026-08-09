/**
 * Server identity, shared by every transport (stdio and HTTP).
 *
 * Kept at the top of src/ deliberately: the version is read from package.json
 * via a relative path that must resolve one level below the package root, which
 * holds for both `src/version.ts` (run via tsx) and `dist/version.js` (built).
 */
import { createRequire } from "node:module";

export const SERVER_NAME = "home-assistant-mcp";

export const SERVER_VERSION = (
	createRequire(import.meta.url)("../package.json") as { version: string }
).version;

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

/**
 * How this process is being run: "hosted" for `serve` (the multi-tenant server
 * behind vome.io/mcp), "stdio" for a copy someone runs themselves (npm/npx).
 */
export type ClientMode = "hosted" | "stdio";

let clientMode: ClientMode = "stdio";

export function setClientMode(mode: ClientMode): void {
	clientMode = mode;
}

/**
 * The User-Agent sent on every request to the Vome portal. The portal records
 * it with each brokered call (in its audit log, next to the user and token it
 * already has), so it can tell the hosted server from a copy run from npm from
 * a script. Without it Node's fetch says only "node", and an npm user looked
 * the same as everything else. It names the package, version and mode: nothing
 * about the machine or the home.
 */
export function userAgent(): string {
	return `${SERVER_NAME}/${SERVER_VERSION} (${clientMode})`;
}

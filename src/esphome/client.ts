/**
 * The ESPHome client contract, and the client used when there is no route to one.
 *
 * There is exactly one way to reach ESPHome now: through a VomeHome
 * relay-connected Home Assistant, where the Vome component translates the
 * dashboard's `/ws` API into the stable stream this client consumes.
 *
 * The direct route (`ESPHOME_DASHBOARD_URL`) is gone. It spoke ESPHome's old
 * per-command WebSockets and `/edit` REST endpoint, which
 * `esphome-device-builder` deleted; and on a default install it could not work
 * anyway, since the add-on is host-networked with its web port disabled behind
 * an ingress that admits only the Supervisor and localhost. Keeping it would
 * have meant maintaining a second implementation of a protocol that only the
 * component can actually reach.
 */

/** Commands Vome exposes, each mapped to a dashboard `/ws` command by the component. */
export type EsphomeStreamCommand = "validate" | "compile" | "upload" | "logs" | "clean";

export interface EsphomeCommandRequest {
	command: EsphomeStreamCommand;
	configuration: string;
	port?: string;
	timeoutMs?: number;
	maxLines?: number;
}

export interface EsphomeCommandResult {
	command: string;
	configuration: string;
	exitCode: number | null;
	output: string;
	truncated: boolean;
	/**
	 * True when *we* stopped watching because the timeout elapsed, rather than
	 * the command reporting a result. For an open-ended command like `logs`
	 * that is the normal ending, not a failure.
	 */
	timedOut?: boolean;
}

export type EsphomeAccessMode = "brokered" | "unavailable";

export interface EsphomeAccessStatus {
	mode: EsphomeAccessMode;
	/** True when validate/compile/upload/logs/clean can run. */
	streaming: boolean;
	instance: string | null;
	note?: string;
}

export interface EsphomeClient {
	isEnabled(): boolean;
	listDevices(): Promise<unknown>;
	getVersion(): Promise<unknown>;
	getConfig(configuration: string): Promise<string>;
	saveConfig(configuration: string, yaml: string): Promise<void>;
	runCommand(request: EsphomeCommandRequest): Promise<EsphomeCommandResult>;
	/** Which ESPHome rename rules a config still needs. */
	getMigrations(configuration: string): Promise<unknown>;
	/** How ESPHome is reached, for `esphome_dashboard_info`. */
	describe(): Promise<EsphomeAccessStatus>;
}

export class EsphomeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EsphomeError";
	}
}

const NO_ROUTE =
	"ESPHome is reached through a VomeHome relay-connected Home Assistant, and this " +
	"server has none configured. Set VOMEHOME_TOKEN and a relay instance, and make sure " +
	"the home runs the Vome add-on — it is the only thing that can reach the ESPHome " +
	"dashboard, which the add-on keeps on localhost by default.";

/**
 * Stands in when nothing can reach ESPHome, so every tool fails the same way
 * and says what to do about it rather than surfacing a connection error from
 * whichever call happened to run first.
 */
export function createUnavailableEsphomeClient(): EsphomeClient {
	const refuse = async (): Promise<never> => {
		throw new EsphomeError(NO_ROUTE);
	};
	return {
		isEnabled: () => false,
		listDevices: refuse,
		getVersion: refuse,
		getConfig: refuse,
		saveConfig: refuse,
		runCommand: refuse,
		getMigrations: refuse,
		describe: async () => ({
			mode: "unavailable",
			streaming: false,
			instance: null,
			note: NO_ROUTE
		})
	};
}

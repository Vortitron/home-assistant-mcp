import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { bridgeConnection } from "../src/cli/tunnel.js";

const noopLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as Parameters<typeof bridgeConnection>[3];

interface Rig {
	wsUrl: string;
	localPort: number;
	close: () => Promise<void>;
}

/**
 * Stand up a fake `/ws/tcp` relay that echoes binary frames back, plus a local
 * TCP listener that bridges each accepted connection to it — the real byte path
 * the CLI uses, minus the process/CLI lifecycle.
 */
async function makeRig(): Promise<Rig> {
	const wss = new WebSocketServer({ port: 0 });
	wss.on("connection", (client) => {
		client.on("message", (data, isBinary) => {
			if (isBinary) {
				client.send(data, { binary: true });
			}
		});
	});
	await new Promise((r) => wss.once("listening", r));
	const wsPort = (wss.address() as net.AddressInfo).port;
	const wsUrl = `ws://127.0.0.1:${wsPort}/ws/tcp`;

	const local = net.createServer((socket) =>
		bridgeConnection(socket, wsUrl, "test-token", noopLogger),
	);
	await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
	const localPort = (local.address() as net.AddressInfo).port;

	return {
		wsUrl,
		localPort,
		close: () =>
			new Promise<void>((r) => {
				local.close(() => wss.close(() => r()));
			}),
	};
}

describe("bridgeConnection", () => {
	let rig: Rig | undefined;
	afterEach(async () => {
		await rig?.close();
		rig = undefined;
	});

	it("delivers bytes written immediately on connect (before the WS opens)", async () => {
		rig = await makeRig();
		const payload = Buffer.from("RDP\x00opening-bytes");

		const echoed = await new Promise<Buffer>((resolve, reject) => {
			const client = net.connect(rig!.localPort, "127.0.0.1", () => {
				// Write the instant the TCP socket connects — the outbound WS is
				// still handshaking here, which is exactly the dropped-bytes bug.
				client.write(payload);
			});
			const chunks: Buffer[] = [];
			client.on("data", (d) => {
				chunks.push(d);
				resolve(Buffer.concat(chunks));
				client.end();
			});
			client.on("error", reject);
			setTimeout(() => reject(new Error("no bytes echoed back within 4s")), 4000);
		});

		expect(echoed.equals(payload)).toBe(true);
	});
});

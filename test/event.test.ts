// End-to-end tests for POST /api/event — the bot-event injection hook (#8).
//
// Boots a real createBridgeServer on an ephemeral loopback port with a stubbed
// PiClient and verifies that a framed bot event maps its priority band to the
// right pi delivery discipline (steer vs followUp) and injects as a prompt.

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth.js";
import type { Config } from "../src/config.js";
import type { PiClient } from "../src/pi-client.js";
import { createBridgeServer } from "../src/server.js";
import type { RpcCommandBody, RpcResponse } from "../src/types.js";
import { WsHub } from "../src/ws-hub.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

interface StubPiClient {
	sendCalls: RpcCommandBody[];
	send(command: RpcCommandBody): Promise<RpcResponse>;
	isRunning(): boolean;
}

function makeStubPiClient(): StubPiClient {
	const stub: StubPiClient = {
		sendCalls: [],
		async send(command: RpcCommandBody): Promise<RpcResponse> {
			stub.sendCalls.push(command);
			return { id: "req_test", type: "response", command: command.type, success: true };
		},
		isRunning(): boolean {
			return true;
		},
	};
	return stub;
}

const config: Config = {
	bindHost: "127.0.0.1",
	bindPort: 0,
	bearerToken: TOKEN,
	pi: { cwd: "/tmp", binary: "pi", args: [], restartBackoffMs: 1000, responseTimeoutMs: 1000 },
	ws: { pingIntervalMs: 30_000, extensionRequestTtlMs: 60_000 },
	logLevel: "error",
};

let server: Server;
let baseUrl: string;
let stubPi: StubPiClient;
let hub: WsHub;

beforeAll(async () => {
	stubPi = makeStubPiClient();
	const piClient = stubPi as unknown as PiClient;
	const auth = createAuth(TOKEN);
	hub = new WsHub({ pingIntervalMs: 30_000, extensionRequestTtlMs: 60_000, auth, piClient });
	server = createBridgeServer({ config, auth, piClient, wsHub: hub });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function postEvent(body: unknown, withToken = true): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (withToken) headers.authorization = `Bearer ${TOKEN}`;
	return fetch(`${baseUrl}/api/event`, { method: "POST", headers, body: JSON.stringify(body) });
}

function lastSend(): RpcCommandBody {
	return stubPi.sendCalls[stubPi.sendCalls.length - 1];
}

describe("POST /api/event (bot-event injection)", () => {
	it("queues a nav-progress event (priority 30) as a followUp prompt", async () => {
		const before = stubPi.sendCalls.length;
		const res = await postEvent({ message: "[bot event] Arrived at the kitchen.", priority: 30 });
		expect(res.status).toBe(200);
		expect(lastSend()).toEqual({
			type: "prompt",
			message: "[bot event] Arrived at the kitchen.",
			streamingBehavior: "followUp",
		});
		expect(stubPi.sendCalls.length).toBe(before + 1);
	});

	it("preempts an urgent event (priority 10) as a steer prompt", async () => {
		const res = await postEvent({ message: "[bot event] Fault: low battery.", priority: 10 });
		expect(res.status).toBe(200);
		expect(lastSend()).toMatchObject({ type: "prompt", streamingBehavior: "steer" });
	});

	it("defaults to followUp when no priority is given", async () => {
		const res = await postEvent({ message: "no priority" });
		expect(res.status).toBe(200);
		expect(lastSend()).toMatchObject({ streamingBehavior: "followUp" });
	});

	it("rejects a missing message with 400", async () => {
		const res = await postEvent({ priority: 30 });
		expect(res.status).toBe(400);
	});

	it("rejects a non-number priority with 400", async () => {
		const res = await postEvent({ message: "x", priority: "high" });
		expect(res.status).toBe(400);
	});

	it("requires the bearer token (401 without it, handler never reached)", async () => {
		const before = stubPi.sendCalls.length;
		const res = await postEvent({ message: "x" }, false);
		expect(res.status).toBe(401);
		expect(stubPi.sendCalls.length).toBe(before);
	});
});

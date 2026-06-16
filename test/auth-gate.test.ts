// End-to-end tests for the server-layer auth gate.
//
// auth.test.ts covers validateRest/validateWs in isolation; nothing there
// proves the server actually consults them before dispatch. These tests boot
// a real createBridgeServer on an ephemeral loopback port with a stubbed
// PiClient and verify over real HTTP/WS that:
//   - unauthenticated / wrong-token REST gets a generic 401 and never reaches
//     a handler (auth happens before route dispatch, so routes can't be probed)
//   - /health stays deliberately unauthenticated
//   - a valid token passes through to the handler (positive control)
//   - a WS upgrade without / with a wrong bearer subprotocol is rejected
//     before the handshake; a valid one completes it

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createAuth } from "../src/auth.js";
import type { Config } from "../src/config.js";
import type { PiClient } from "../src/pi-client.js";
import { createBridgeServer } from "../src/server.js";
import type { RpcCommandBody, RpcResponse } from "../src/types.js";
import { WsHub } from "../src/ws-hub.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WRONG_TOKEN = "f".repeat(TOKEN.length);

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
			return { id: "req_test", type: "response", command: command.type, success: true, data: { stubbed: true } };
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
let wsUrl: string;
let stubPi: StubPiClient;
let hub: WsHub;

beforeAll(async () => {
	stubPi = makeStubPiClient();
	const piClient = stubPi as unknown as PiClient;
	const auth = createAuth(TOKEN);
	// hub.start() is deliberately not called — these tests exercise only the
	// upgrade/auth path; no pi fan-out or ping timers needed.
	hub = new WsHub({ pingIntervalMs: 30_000, extensionRequestTtlMs: 60_000, auth, piClient });
	server = createBridgeServer({ config, auth, piClient, wsHub: hub });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${addr.port}`;
	wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("REST auth gate (server layer)", () => {
	it("rejects a request with no Authorization header with a generic 401", async () => {
		const res = await fetch(`${baseUrl}/api/session/state`);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized" });
	});

	it("rejects a wrong token of the correct length", async () => {
		const res = await fetch(`${baseUrl}/api/session/state`, {
			headers: { authorization: `Bearer ${WRONG_TOKEN}` },
		});
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized" });
	});

	it("rejects a malformed Authorization header (no Bearer prefix)", async () => {
		const res = await fetch(`${baseUrl}/api/session/state`, { headers: { authorization: TOKEN } });
		expect(res.status).toBe(401);
	});

	it("never reaches a handler on auth failure", async () => {
		const before = stubPi.sendCalls.length;
		const res = await fetch(`${baseUrl}/api/session/state`);
		expect(res.status).toBe(401);
		expect(stubPi.sendCalls.length).toBe(before);
	});

	it("auth-gates unknown routes too (401 before 404 — no route probing)", async () => {
		const res = await fetch(`${baseUrl}/api/does-not-exist`);
		expect(res.status).toBe(401);
	});

	it("passes a valid token through to the handler (positive control)", async () => {
		const before = stubPi.sendCalls.length;
		const res = await fetch(`${baseUrl}/api/session/state`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		expect(stubPi.sendCalls.length).toBe(before + 1);
	});

	it("leaves /health unauthenticated by design", async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok", piRunning: true });
	});
});

describe("WS upgrade auth gate", () => {
	function expectRejectedHandshake(ws: WebSocket): Promise<Error> {
		return new Promise((resolve, reject) => {
			ws.once("error", resolve);
			ws.once("open", () => reject(new Error("handshake unexpectedly completed")));
		});
	}

	it("rejects an upgrade with no bearer subprotocol before the handshake", async () => {
		const err = await expectRejectedHandshake(new WebSocket(wsUrl));
		expect(err.message).toContain("401");
	});

	it("rejects an upgrade with a wrong bearer token", async () => {
		const err = await expectRejectedHandshake(new WebSocket(wsUrl, [`bearer.${WRONG_TOKEN}`]));
		expect(err.message).toContain("401");
	});

	it("completes the handshake with a valid bearer subprotocol", async () => {
		const ws = new WebSocket(wsUrl, [`bearer.${TOKEN}`]);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		expect(hub.getClientCount()).toBe(1);
		ws.close();
		await new Promise<void>((resolve) => ws.once("close", () => resolve()));
	});
});

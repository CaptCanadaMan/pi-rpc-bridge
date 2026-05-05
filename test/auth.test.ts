import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeReq(headers: Record<string, string>): IncomingMessage {
	// Minimal stub — we only need .headers for these tests.
	return { headers } as unknown as IncomingMessage;
}

describe("createAuth.validateRest", () => {
	const auth = createAuth(TOKEN);

	it("accepts a valid bearer token", () => {
		expect(auth.validateRest(makeReq({ authorization: `Bearer ${TOKEN}` })).ok).toBe(true);
	});

	it("rejects a missing Authorization header", () => {
		const result = auth.validateRest(makeReq({}));
		expect(result).toEqual({ ok: false, reason: expect.stringContaining("missing") });
	});

	it("rejects a malformed Authorization header", () => {
		const result = auth.validateRest(makeReq({ authorization: TOKEN }));
		expect(result.ok).toBe(false);
	});

	it("rejects a wrong token of the same length", () => {
		const wrong = "f".repeat(TOKEN.length);
		const result = auth.validateRest(makeReq({ authorization: `Bearer ${wrong}` }));
		expect(result).toEqual({ ok: false, reason: "invalid bearer token" });
	});

	it("rejects a wrong token of a different length without throwing", () => {
		const result = auth.validateRest(makeReq({ authorization: "Bearer short" }));
		expect(result).toEqual({ ok: false, reason: "invalid bearer token" });
	});
});

describe("createAuth.validateWs", () => {
	const auth = createAuth(TOKEN);

	it("accepts a bearer.<token> subprotocol", () => {
		expect(auth.validateWs(makeReq({ "sec-websocket-protocol": `bearer.${TOKEN}` })).ok).toBe(true);
	});

	it("accepts when bearer protocol is among multiple comma-separated", () => {
		expect(
			auth.validateWs(makeReq({ "sec-websocket-protocol": `something-else, bearer.${TOKEN}, json` })).ok,
		).toBe(true);
	});

	it("rejects when no bearer.* protocol is present", () => {
		const result = auth.validateWs(makeReq({ "sec-websocket-protocol": "graphql, json" }));
		expect(result.ok).toBe(false);
	});

	it("rejects when the bearer token is wrong", () => {
		const wrong = "f".repeat(TOKEN.length);
		const result = auth.validateWs(makeReq({ "sec-websocket-protocol": `bearer.${wrong}` }));
		expect(result).toEqual({ ok: false, reason: "invalid bearer token" });
	});

	it("rejects a missing Sec-WebSocket-Protocol header", () => {
		const result = auth.validateWs(makeReq({}));
		expect(result.ok).toBe(false);
	});
});

describe("createAuth — origin allowlist (REST)", () => {
	const auth = createAuth(TOKEN, ["https://app.example.com", "https://admin.example.com"]);

	it("accepts when no Origin header is present (non-browser client)", () => {
		expect(auth.validateRest(makeReq({ authorization: `Bearer ${TOKEN}` })).ok).toBe(true);
	});

	it("accepts when Origin matches an entry in the allowlist", () => {
		expect(
			auth.validateRest(
				makeReq({ authorization: `Bearer ${TOKEN}`, origin: "https://app.example.com" }),
			).ok,
		).toBe(true);
	});

	it("rejects when Origin is not in the allowlist", () => {
		const result = auth.validateRest(
			makeReq({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example.com" }),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects on Origin mismatch even if token is valid (Origin checked first)", () => {
		const result = auth.validateRest(
			makeReq({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example.com" }),
		);
		expect(result).toEqual({ ok: false, reason: expect.stringContaining("evil.example.com") });
	});
});

describe("createAuth — origin allowlist (WS)", () => {
	const auth = createAuth(TOKEN, ["https://app.example.com"]);

	it("accepts when no Origin header is present", () => {
		expect(auth.validateWs(makeReq({ "sec-websocket-protocol": `bearer.${TOKEN}` })).ok).toBe(true);
	});

	it("accepts when Origin matches", () => {
		expect(
			auth.validateWs(
				makeReq({
					"sec-websocket-protocol": `bearer.${TOKEN}`,
					origin: "https://app.example.com",
				}),
			).ok,
		).toBe(true);
	});

	it("rejects when Origin is not in the allowlist", () => {
		const result = auth.validateWs(
			makeReq({
				"sec-websocket-protocol": `bearer.${TOKEN}`,
				origin: "https://evil.example.com",
			}),
		);
		expect(result.ok).toBe(false);
	});
});

describe("createAuth — empty origin allowlist behaves as none", () => {
	const auth = createAuth(TOKEN, []);

	it("accepts any Origin when allowlist is empty array", () => {
		expect(
			auth.validateRest(
				makeReq({ authorization: `Bearer ${TOKEN}`, origin: "https://anywhere.example.com" }),
			).ok,
		).toBe(true);
	});
});

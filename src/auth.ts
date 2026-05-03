// Bearer token validation.
//
// Two surfaces:
//   - REST: `Authorization: Bearer <token>` header
//   - WS:   bearer token sent via `Sec-WebSocket-Protocol: bearer.<token>` subprotocol
//
// Why subprotocol for WS: browsers and the iOS WebSocket API can pass an array
// of subprotocols at handshake but cannot set arbitrary headers. The
// subprotocol slot is the canonical way to ferry an opaque token through to
// the server during the upgrade. We don't use the subprotocol for actual
// protocol negotiation, so this is just a transport for the credential.
//
// Constant-time compare on both surfaces. Fail-closed with a generic 401 — no
// hint in the response body about what was wrong.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type AuthResult = { ok: true } | { ok: false; reason: string };

export interface Auth {
	validateRest(req: IncomingMessage): AuthResult;
	validateWs(req: IncomingMessage): AuthResult;
}

export const WS_SUBPROTOCOL_PREFIX = "bearer.";

export function createAuth(expectedToken: string): Auth {
	const expected = Buffer.from(expectedToken, "utf8");

	function compare(provided: string): boolean {
		const actual = Buffer.from(provided, "utf8");
		if (actual.length !== expected.length) return false;
		return timingSafeEqual(actual, expected);
	}

	return {
		validateRest(req) {
			const header = req.headers.authorization;
			if (typeof header !== "string") {
				return { ok: false, reason: "missing Authorization header" };
			}
			const match = /^Bearer (.+)$/.exec(header);
			if (!match) {
				return { ok: false, reason: "Authorization must be 'Bearer <token>'" };
			}
			if (!compare(match[1])) {
				return { ok: false, reason: "invalid bearer token" };
			}
			return { ok: true };
		},

		validateWs(req) {
			const header = req.headers["sec-websocket-protocol"];
			if (typeof header !== "string") {
				return { ok: false, reason: "missing Sec-WebSocket-Protocol header" };
			}
			const protocols = header
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const tokenProto = protocols.find((p) => p.startsWith(WS_SUBPROTOCOL_PREFIX));
			if (!tokenProto) {
				return { ok: false, reason: `no ${WS_SUBPROTOCOL_PREFIX}<token> subprotocol` };
			}
			const token = tokenProto.slice(WS_SUBPROTOCOL_PREFIX.length);
			if (!compare(token)) {
				return { ok: false, reason: "invalid bearer token" };
			}
			return { ok: true };
		},
	};
}

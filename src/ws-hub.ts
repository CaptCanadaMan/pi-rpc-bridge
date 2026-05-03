// WsHub — WebSocket connection manager.
//
// Responsibilities:
//   - Authenticate WS upgrade requests via bearer-subprotocol (auth.validateWs).
//   - Maintain a Set<WebSocket> of authenticated, live connections.
//   - Fan out every line pi emits (events + extension_ui_request) to all clients.
//   - Server-side ping every pingIntervalMs; close connections that miss pongs.
//   - For interactive extension_ui_request (select/confirm/input/editor): track
//     the request id, accept the FIRST extension_ui_response from any client,
//     forward it to pi's stdin, and drop any subsequent responses for the same id.
//   - Fire-and-forget UI requests (notify/setStatus/setWidget/setTitle/set_editor_text)
//     are broadcast like any other event; no response routing needed.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { type Auth, WS_SUBPROTOCOL_PREFIX } from "./auth.js";
import type { PiClient } from "./pi-client.js";
import { INTERACTIVE_UI_METHODS } from "./types.js";

function rawDataToString(data: RawData): string {
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return Buffer.from(data).toString("utf8");
}

export interface WsHubOptions {
	pingIntervalMs: number;
	extensionRequestTtlMs: number;
	auth: Auth;
	piClient: PiClient;
}

interface PendingExtRequest {
	expiresAt: number;
}

export class WsHub {
	private wss: WebSocketServer;
	private clients = new Set<WebSocket>();
	private alive = new WeakMap<WebSocket, boolean>();
	private pingTimer: NodeJS.Timeout | null = null;
	private gcTimer: NodeJS.Timeout | null = null;
	private pendingExtRequests = new Map<string, PendingExtRequest>();
	private unsubscribePi: (() => void) | null = null;

	constructor(private opts: WsHubOptions) {
		// handleProtocols ensures the WS handshake echoes back the bearer.<token>
		// subprotocol regardless of what other protocols the client sent.
		// Auth has already validated the token at this point (see handleUpgrade).
		this.wss = new WebSocketServer({
			noServer: true,
			handleProtocols: (protocols) => {
				for (const p of protocols) {
					if (p.startsWith(WS_SUBPROTOCOL_PREFIX)) return p;
				}
				return false;
			},
		});
	}

	start(): void {
		this.unsubscribePi = this.opts.piClient.onLine((line, parsed) => {
			this.trackIfInteractiveRequest(parsed);
			this.broadcast(line);
		});

		this.pingTimer = setInterval(() => this.runPingSweep(), this.opts.pingIntervalMs);

		// GC stale pending extension requests at 1/4 the TTL frequency
		this.gcTimer = setInterval(() => this.gcPendingExtRequests(), Math.max(15_000, this.opts.extensionRequestTtlMs / 4));
	}

	stop(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
		if (this.gcTimer) {
			clearInterval(this.gcTimer);
			this.gcTimer = null;
		}
		this.unsubscribePi?.();
		this.unsubscribePi = null;
		for (const ws of this.clients) {
			ws.close(1001, "server shutting down");
		}
		this.clients.clear();
		this.pendingExtRequests.clear();
	}

	/** Handle an HTTP upgrade. Validates auth before completing the WS handshake. */
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const result = this.opts.auth.validateWs(req);
		if (!result.ok) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		this.wss.handleUpgrade(req, socket, head, (ws) => {
			this.attachClient(ws);
		});
	}

	getClientCount(): number {
		return this.clients.size;
	}

	private attachClient(ws: WebSocket): void {
		this.clients.add(ws);
		this.alive.set(ws, true);

		ws.on("pong", () => {
			this.alive.set(ws, true);
		});

		ws.on("message", (data) => {
			this.handleClientMessage(rawDataToString(data));
		});

		ws.on("close", () => {
			this.clients.delete(ws);
		});

		ws.on("error", () => {
			this.clients.delete(ws);
		});
	}

	private handleClientMessage(text: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}

		if (typeof parsed !== "object" || parsed === null) return;
		const obj = parsed as Record<string, unknown>;
		if (obj.type !== "extension_ui_response") return;
		if (typeof obj.id !== "string") return;

		// First-response-wins: drop if the id isn't in our pending set.
		// (Could be a stale response after another client already answered, or
		// an unsolicited message; either way, don't forward to pi.)
		if (!this.pendingExtRequests.has(obj.id)) return;

		this.pendingExtRequests.delete(obj.id);
		try {
			this.opts.piClient.sendRaw(parsed);
		} catch (err) {
			console.error(`[ws-hub] failed to forward extension_ui_response: ${(err as Error).message}`);
		}
	}

	private trackIfInteractiveRequest(parsed: unknown): void {
		if (typeof parsed !== "object" || parsed === null) return;
		const obj = parsed as Record<string, unknown>;
		if (obj.type !== "extension_ui_request") return;
		if (typeof obj.id !== "string" || typeof obj.method !== "string") return;
		if (!INTERACTIVE_UI_METHODS.has(obj.method)) return;

		this.pendingExtRequests.set(obj.id, { expiresAt: Date.now() + this.opts.extensionRequestTtlMs });
	}

	private gcPendingExtRequests(): void {
		const now = Date.now();
		for (const [id, entry] of this.pendingExtRequests) {
			if (entry.expiresAt < now) {
				this.pendingExtRequests.delete(id);
			}
		}
	}

	private broadcast(line: string): void {
		for (const ws of this.clients) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(line);
			}
		}
	}

	private runPingSweep(): void {
		for (const ws of this.clients) {
			if (this.alive.get(ws) === false) {
				ws.terminate();
				this.clients.delete(ws);
				continue;
			}
			this.alive.set(ws, false);
			ws.ping();
		}
	}
}

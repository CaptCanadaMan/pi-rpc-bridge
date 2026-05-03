// HTTP + WebSocket server wiring.
//
// Composition:
//   - node:http server handles REST (auth-gated except /health) and the upgrade
//     event for WS connections.
//   - WsHub owns the WebSocket lifecycle once an upgrade is accepted.
//   - PiClient is the underlying transport to pi.
//
// Auth strategy:
//   - REST: every route except /health goes through auth.validateRest first.
//     401 on failure with no detail in the body.
//   - WS: handled inside WsHub.handleUpgrade — auth.validateWs checks the
//     bearer subprotocol before completing the handshake.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import { createRoutes } from "./handlers/index.js";
import { getPathname, sendError } from "./http-utils.js";
import type { PiClient } from "./pi-client.js";
import { findRoute, type Route } from "./routes.js";
import type { WsHub } from "./ws-hub.js";

const WS_PATH = "/ws";
const UNAUTHENTICATED_PATHS: ReadonlySet<string> = new Set(["/health"]);

export interface ServerDeps {
	config: Config;
	auth: Auth;
	piClient: PiClient;
	wsHub: WsHub;
}

export function createBridgeServer(deps: ServerDeps): Server {
	const routes = createRoutes({ piClient: deps.piClient });

	const server = createServer((req, res) => {
		void handleRequest(req, res, routes, deps).catch((err: unknown) => {
			console.error("[server] uncaught request error:", err);
			if (!res.headersSent) {
				sendError(res, 500, "internal server error");
			} else {
				res.end();
			}
		});
	});

	server.on("upgrade", (req, socket, head) => {
		try {
			const pathname = getPathname(req);
			if (pathname !== WS_PATH) {
				socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			deps.wsHub.handleUpgrade(req, socket, head);
		} catch (err) {
			console.error("[server] upgrade error:", err);
			try {
				socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
			} catch {
				// socket already destroyed
			}
			socket.destroy();
		}
	});

	return server;
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	routes: Route[],
	deps: ServerDeps,
): Promise<void> {
	const pathname = getPathname(req);
	const method = req.method ?? "GET";

	if (!UNAUTHENTICATED_PATHS.has(pathname)) {
		const result = deps.auth.validateRest(req);
		if (!result.ok) {
			logAuthFailure(req, result.reason);
			sendError(res, 401, "unauthorized");
			return;
		}
	}

	const route = findRoute(routes, method, pathname);
	if (!route) {
		sendError(res, 404, `no route for ${method} ${pathname}`);
		return;
	}

	await route.handler(req, res);
}

function logAuthFailure(req: IncomingMessage, reason: string): void {
	const sourceIp = req.socket.remoteAddress ?? "unknown";
	const method = req.method ?? "?";
	const url = req.url ?? "/";
	console.error(`[auth] reject ${method} ${url} from ${sourceIp}: ${reason}`);
}

#!/usr/bin/env node

// pi-rpc-bridge — daemon entry point.
//
// Boot sequence:
//   1. Load config (env + optional config file)
//   2. Construct dependency graph: Auth, PiClient, WsHub, HTTP server
//   3. Start PiClient (spawns pi --mode rpc)
//   4. Start WsHub (subscribes to PiClient events)
//   5. Listen on configured bind:port
//   6. Install SIGINT/SIGTERM handlers for graceful shutdown
//
// Shutdown sequence (on SIGINT or SIGTERM):
//   1. Stop accepting new HTTP connections
//   2. Close all WS clients
//   3. SIGTERM pi child process (SIGKILL after 1s if it doesn't exit)
//   4. Exit 0 once http.Server.close fires (or after 5s force-exit)

import { createAuth } from "./auth.js";
import { type Config, loadConfig } from "./config.js";
import { PiClient } from "./pi-client.js";
import { createBridgeServer } from "./server.js";
import { WsHub } from "./ws-hub.js";

const FORCE_EXIT_TIMEOUT_MS = 5000;

async function main(): Promise<void> {
	const config = loadConfig();
	logBootBanner(config);

	const auth = createAuth(config.bearerToken, config.allowedOrigins);

	const piClient = new PiClient({
		binary: config.pi.binary,
		cwd: config.pi.cwd,
		args: config.pi.args,
		restartBackoffMs: config.pi.restartBackoffMs,
		responseTimeoutMs: config.pi.responseTimeoutMs,
	});

	const wsHub = new WsHub({
		pingIntervalMs: config.ws.pingIntervalMs,
		extensionRequestTtlMs: config.ws.extensionRequestTtlMs,
		auth,
		piClient,
	});

	piClient.start();
	wsHub.start();

	const server = createBridgeServer({ config, auth, piClient, wsHub });

	server.listen(config.bindPort, config.bindHost, () => {
		console.error(`[pi-rpc-bridge] listening on http://${config.bindHost}:${config.bindPort}`);
		console.error(`[pi-rpc-bridge] WS endpoint: ws://${config.bindHost}:${config.bindPort}/ws`);
		console.error(`[pi-rpc-bridge] health: GET http://${config.bindHost}:${config.bindPort}/health`);
	});

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(`[pi-rpc-bridge] received ${signal}, shutting down`);

		// Force-exit safety net.
		const forceExit = setTimeout(() => {
			console.error("[pi-rpc-bridge] forced exit after shutdown timeout");
			process.exit(1);
		}, FORCE_EXIT_TIMEOUT_MS);
		forceExit.unref();

		server.close();
		wsHub.stop();
		await piClient.stop();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function logBootBanner(config: Config): void {
	console.error("[pi-rpc-bridge] booting");
	console.error(`[pi-rpc-bridge] pi binary: ${config.pi.binary}`);
	console.error(`[pi-rpc-bridge] pi cwd:    ${config.pi.cwd}`);
	console.error(`[pi-rpc-bridge] log level: ${config.logLevel}`);
	if (config.allowedOrigins && config.allowedOrigins.length > 0) {
		console.error(`[pi-rpc-bridge] origin allowlist: ${config.allowedOrigins.join(", ")}`);
	} else {
		console.error("[pi-rpc-bridge] origin allowlist: (none — Origin header not validated)");
	}
	// Token never printed.
}

main().catch((err: unknown) => {
	console.error("[pi-rpc-bridge] fatal:", err);
	process.exit(1);
});

#!/usr/bin/env node

// pi-rpc-bridge — daemon entry point.
//
// Loads config, spawns `pi --mode rpc`, starts the HTTP+WS server.
// See CLAUDE.md for architecture and implementation order.

import { startServer } from "./server.js";

async function main(): Promise<void> {
	await startServer();
}

main().catch((err: unknown) => {
	console.error("[pi-rpc-bridge] fatal:", err);
	process.exit(1);
});

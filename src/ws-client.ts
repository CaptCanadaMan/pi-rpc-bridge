// CLI WebSocket client for testing the bridge end-to-end.
//
// Connects to the bridge's /ws endpoint with bearer-token auth and prints
// every JSONL line it receives to stdout. Server logs go to stderr.
//
// Usage:
//   PI_RPC_BRIDGE_BEARER_TOKEN=<token> npm run ws-client
//   PI_RPC_BRIDGE_BEARER_TOKEN=<token> npm run ws-client -- ws://homelab:8787/ws
//
// Node 20.6 doesn't ship a stable native WebSocket, so this uses the `ws`
// package the project already depends on.

import { WebSocket } from "ws";

const url = process.argv[2] ?? "ws://127.0.0.1:8787/ws";
const token = process.env.PI_RPC_BRIDGE_BEARER_TOKEN;
if (!token) {
	console.error("[ws-client] PI_RPC_BRIDGE_BEARER_TOKEN env var is required");
	process.exit(1);
}

console.error(`[ws-client] connecting to ${url}`);

const ws = new WebSocket(url, [`bearer.${token}`]);

ws.on("open", () => {
	console.error("[ws-client] connected");
});

ws.on("message", (data) => {
	const text = Buffer.isBuffer(data)
		? data.toString("utf8")
		: Array.isArray(data)
			? Buffer.concat(data).toString("utf8")
			: Buffer.from(data).toString("utf8");
	process.stdout.write(`${text}\n`);
});

ws.on("close", (code, reason) => {
	console.error(`[ws-client] closed (code=${code}, reason=${reason.toString("utf8") || "(none)"})`);
	process.exit(0);
});

ws.on("error", (err: Error) => {
	console.error(`[ws-client] error: ${err.message}`);
	process.exit(1);
});

process.on("SIGINT", () => {
	ws.close();
});

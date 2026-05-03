// HTTP + WebSocket server.
//
// Real implementation will wire up:
//   - node:http for REST endpoints (see routes.ts + handlers/)
//   - ws for WebSocket fan-out and inbound extension_ui_response (see ws-hub.ts)
//   - bearer-token auth (see auth.ts)
//   - pi RpcClient wrapper (see pi-client.ts)
//   - config loading (see config.ts)

export async function startServer(): Promise<void> {
	console.error("[pi-rpc-bridge] scaffold — server not yet implemented");
	console.error("[pi-rpc-bridge] next step: spike (HTTP POST /spike/prompt → pi → WS event stream)");
	console.error("[pi-rpc-bridge] see CLAUDE.md §Implementation order");
}

// WebSocket connection hub.
//
// Real implementation will:
//   - maintain Set<WebSocket> of authenticated, live connections
//   - server-side ping every ~30s; close connections that miss pongs
//   - fan-out: every event from pi gets broadcast to every connected client
//   - extension UI request routing:
//       - Map<requestId, pendingRequest> tracks open interactive requests
//       - first incoming extension_ui_response wins; subsequent ones for the
//         same id are dropped at the bridge before reaching pi
//       - no bridge-side timeout — pi handles its own deadlines

export {};

// Bearer token validation.
//
// Real implementation will:
//   - load expected token from config (see config.ts)
//   - validate Authorization header for REST (`Bearer <token>`)
//   - validate Sec-WebSocket-Protocol header for WS handshake
//   - constant-time compare to defeat timing side-channels
//   - fail-closed with 401 on missing / malformed / wrong token
//   - log auth failures with source IP (no token material in logs)
//
// Forward-compat: future "trusted-proxy" mode will accept pre-authenticated
// requests via X-Forwarded-User from a configured upstream IP. Not in v1.

export {};

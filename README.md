# pi-rpc-bridge

HTTP + WebSocket bridge for [`pi --mode rpc`](https://github.com/earendil-works/pi-mono). Drive a pi coding agent running on your homelab from any client that speaks HTTPS, over a network layer of your choice — Tailscale, Headscale, mTLS-direct, self-hosted WireGuard, or behind an enterprise reverse proxy.

**Status:** v0 — functional and smoke-tested end-to-end. Not yet published to npm. Run from source for now.

```
[mobile/desktop client] ←HTTPS+WSS over <transport>→ [pi-rpc-bridge] ←stdin/stdout→ [pi --mode rpc]
   (any HTTP client)        (Tailscale, Headscale,        (this project,                  (your existing
                             self-hosted WireGuard,         long-running daemon)            pi install)
                             mTLS-direct, etc.)
```

## Why this exists

Pi-mono's `--mode rpc` flag exposes the agent over JSON-lines on stdin/stdout, designed for in-process embedding via the TypeScript SDK — not for network access. Community projects have already wrapped that protocol in different shapes:

- [ayagmar/pi-mobile](https://github.com/ayagmar/pi-mobile) — Node bridge + Android client, bundled together.
- [pugliatechs/polpo](https://github.com/pugliatechs/polpo) — multi-agent dashboard supporting pi alongside Claude Code, Codex, Gemini, OpenCode, and Goose.
- [earendil-works/pi-mono](https://github.com/earendil-works/pi-mono) (in-repo) and [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat) — Slack / Discord / Telegram bots, linked from pi-mono's own README.

pi-rpc-bridge fills a narrower niche, guided by three principles:

- **Sovereignty.** No mandatory 3rd-party services; deployable air-gapped. The [five-tier deployment ladder](#deployment-tiers) makes the trust trade-offs explicit instead of hiding them.
- **Choice.** Operator picks the transport (Tailscale / Headscale / mTLS-direct / self-hosted WireGuard / reverse-proxy). Consumer picks the frontend (this bridge ships nothing of the kind).
- **Separation from client.** The bridge ships only the protocol — bearer-token auth, supervised pi child process, full bidirectional extension UI routing. iOS apps, web UIs, voice interfaces, automation pipelines, and chat bots are all separate projects, free to evolve independently.

~1600 LOC of source (plus ~550 LOC of tests), one runtime dependency (`ws`).

## What this is not

- A pi-mono fork or extension. The bridge spawns a stock `pi --mode rpc` subprocess.
- An iOS / web / chat client. The bridge is the API; clients are separate projects.
- Coupled to any specific transport. Tailscale is the easiest path but not the only one.
- Multi-tenant. v0 is single-user, single bridge instance, single active session at a time.

---

## Quick start (Tier 1 — Tailscale)

Five minutes to a working remote pi. Requires:
- A homelab machine with `pi` installed and a configured provider. Verify with `pi --version`.
- Tailscale on the homelab and on whatever client you'll drive it from.
- This repo cloned and built.

```bash
# 1. Clone and build the bridge
git clone https://github.com/CaptCanadaMan/pi-rpc-bridge.git
cd pi-rpc-bridge
npm install
npm run build

# 2. Generate a bearer token. The umask makes sure the file is created with
#    mode 600 from the start (no brief window where it's world-readable).
mkdir -p ~/.config/pi-rpc-bridge
( umask 077 && openssl rand -hex 32 > ~/.config/pi-rpc-bridge/token )

# 3. Find your Tailscale IP on the bridge host
tailscale ip -4    # e.g. 100.64.0.5

# 4. Start the bridge
PI_RPC_BRIDGE_BIND_HOST=100.64.0.5 \
PI_RPC_BRIDGE_BEARER_TOKEN=$(cat ~/.config/pi-rpc-bridge/token) \
PI_RPC_BRIDGE_CWD=$HOME/code/your-project \
node dist/index.js
```

If pi isn't installed yet: `npm install -g @earendil-works/pi-coding-agent`, then set up a provider per the [pi-mono README](https://github.com/earendil-works/pi-mono#quick-start).

You should see:
```
[pi-rpc-bridge] booting
[pi-rpc-bridge] pi binary: pi
[pi-rpc-bridge] pi cwd:    /home/you/code/your-project
[pi-rpc-bridge] listening on http://100.64.0.5:8787
[pi-rpc-bridge] WS endpoint: ws://100.64.0.5:8787/ws
```

From any client on your tailnet:
```bash
TOKEN=<the-token-you-generated>

# Health check (no auth)
curl http://100.64.0.5:8787/health

# Send a prompt
curl -X POST http://100.64.0.5:8787/api/prompt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello"}'

# Watch the event stream (using the included CLI helper)
PI_RPC_BRIDGE_BEARER_TOKEN=$TOKEN \
  npm run ws-client -- ws://100.64.0.5:8787/ws
```

For other deployment options (sovereign overlays, mTLS, reverse proxies), see [Deployment tiers](#deployment-tiers) below.

---

## Configuration

The bridge reads configuration from environment variables, optionally falling back to a JSON config file. Env vars take precedence.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PI_RPC_BRIDGE_BEARER_TOKEN` | yes | — | Bearer token for client auth. Must be ≥32 chars. Generate with `openssl rand -hex 32`. |
| `PI_RPC_BRIDGE_CWD` | yes | — | Working directory pi will run in. The agent's tools (Read, Edit, Bash) are scoped to this path. |
| `PI_RPC_BRIDGE_BIND_HOST` | no | `127.0.0.1` | Address to listen on. Localhost by default; set to your overlay IP (e.g. Tailscale IP) for remote access. |
| `PI_RPC_BRIDGE_BIND_PORT` | no | `8787` | TCP port. |
| `PI_RPC_BRIDGE_PI_BIN` | no | `pi` | Pi binary path. Override if pi isn't on `PATH`. |
| `PI_RPC_BRIDGE_PI_RESTART_BACKOFF_MS` | no | `2000` | Delay before restarting pi after an unexpected exit. |
| `PI_RPC_BRIDGE_PI_RESPONSE_TIMEOUT_MS` | no | `30000` | How long to wait for pi to ack a command. |
| `PI_RPC_BRIDGE_WS_PING_INTERVAL_MS` | no | `30000` | Server-side WS ping interval. Clients that miss a pong are disconnected. |
| `PI_RPC_BRIDGE_WS_EXT_REQUEST_TTL_MS` | no | `300000` | TTL for pending extension UI request ids (garbage-collected after this). |
| `PI_RPC_BRIDGE_ALLOWED_ORIGINS` | no | unset | Comma-separated allowlist of HTTP `Origin` header values. When set, browser-based clients must present a matching `Origin` to connect. Non-browser clients (iOS, curl, ws-client) are unaffected. See [Security](#security). |
| `PI_RPC_BRIDGE_LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |
| `PI_RPC_BRIDGE_CONFIG_FILE` | no | `$XDG_CONFIG_HOME/pi-rpc-bridge/config.json` | Override config file path. |

### Config file

Equivalent to env vars but more comfortable for long-running daemons. Required on POSIX to be `chmod 600` — the loader refuses any group/other-readable mode bits.

```json
{
  "bindHost": "100.64.0.5",
  "bindPort": 8787,
  "bearerToken": "<32+ hex chars>",
  "allowedOrigins": ["https://my-bridge-dashboard.example.com"],
  "pi": {
    "cwd": "/home/you/code/project",
    "binary": "pi",
    "args": [],
    "restartBackoffMs": 2000,
    "responseTimeoutMs": 30000
  },
  "ws": {
    "pingIntervalMs": 30000,
    "extensionRequestTtlMs": 300000
  },
  "logLevel": "info"
}
```

`allowedOrigins` is optional — omit it (or set to `[]`) when there are no browser-based clients. Required only when fronting the bridge from a web app.

```bash
mkdir -p ~/.config/pi-rpc-bridge
$EDITOR ~/.config/pi-rpc-bridge/config.json
chmod 600 ~/.config/pi-rpc-bridge/config.json
```

---

## Security

### Threat model

The bearer token grants effective shell access. The bridge exposes a `/api/bash` endpoint by design — it's part of pi's RPC protocol — so anyone with the token can run arbitrary commands as the bridge process's user. Treat the token like an SSH key:

- Generate from a strong source: `openssl rand -hex 32` (256 bits).
- Store in a file with `chmod 600` or in an env var (never in shell history, never in source).
- Rotate immediately if any device that knew it is compromised.

The bridge is the trust boundary, not anything inside it. Authenticated clients can:
- Run arbitrary commands in the configured `cwd`
- Read/write files anywhere the bridge process has access
- Use any registered model/provider (incurring API costs if cloud providers are configured)

### What the bridge does

- **Bearer-token auth** with constant-time compare (`crypto.timingSafeEqual`) on REST and WS handshake.
- **No cookie-based auth.** CSRF via `Authorization: Bearer ...` is impossible because browsers don't auto-attach `Authorization` headers cross-origin.
- **Optional `Origin` allowlist** (`PI_RPC_BRIDGE_ALLOWED_ORIGINS`) for defense-in-depth against browser-based CSRF. When set, browser clients must present a matching `Origin` header. Non-browser clients (iOS, curl, our `ws-client`) don't send `Origin` and are unaffected. Exact-match only — subdomain wildcards (`https://*.example.com`) are not supported; list each origin explicitly.
- **Fail-closed 401 with no detail** in the response body. Full reason is logged server-side with source IP for tripwire detection.
- **Process args via array** (`child_process.spawn(binary, [args])` — no shell interpretation, immune to argument injection).
- **Strict JSONL framing** on the bridge↔pi pipe (see `src/jsonl.ts`); malformed bytes from pi are dropped, not interpreted.

### What the bridge doesn't do (and why)

- **TLS termination** — operator's responsibility (Caddy/nginx/Tailscale upstream). The bridge speaks plain HTTP/WS so it can run behind any TLS terminator without double-encryption overhead.
- **Filesystem path sandboxing** — moot under the threat model. Anyone with the token has shell access via `/api/bash`; restricting `sessionPath` or `outputPath` doesn't add real defense.
- **Rate limiting** — single-trusted-user assumption; brute-forcing a 256-bit token is computationally infeasible. If you deploy in a hostile multi-user environment, add rate limiting at the transport layer (proxy / firewall).
- **Audit log shipping** — server logs are local. Ship them yourself if needed (`journalctl`, `log stream`, etc.).

### Recommended operator practices

- **Tier 3+ for any non-trusted-network deployment.** Tailscale-internal traffic is encrypted, but a stolen token from a compromised device is full-access. mTLS in front (Tier 3) raises the bar.
- **Set `allowedOrigins`** if you build or run any browser-based client.
- **Don't run multiple bridges sharing a token.** Per-bridge tokens give you a clean rotation story per device/workspace.
- **Treat the bridge host as a privileged target.** It runs your coding agent — keep it patched, restrict SSH appropriately, monitor for unexpected outbound traffic.

## API

All endpoints carry no session id; they operate on pi's currently active session. JSON bodies/responses. Bearer token in `Authorization: Bearer ...` for everything except `/health`.

### REST

```
# Prompting (200 = preflight ack; events stream over WS until agent_end)
POST /api/prompt              { message, images?, streamingBehavior? }
POST /api/steer               { message, images? }
POST /api/follow_up           { message, images? }
POST /api/abort

# Session lifecycle
POST /api/session/new         { parentSession? }
POST /api/session/switch      { sessionPath }
POST /api/session/fork        { entryId }
POST /api/session/clone
POST /api/session/name        { name }
POST /api/session/export      { outputPath? }
GET  /api/session/state
GET  /api/session/messages
GET  /api/session/stats
GET  /api/session/forkable
GET  /api/session/last-text

# Models
GET  /api/models
POST /api/model               { provider, modelId }
POST /api/model/cycle

# Thinking
POST /api/thinking-level      { level }
POST /api/thinking-level/cycle

# Compaction
POST /api/compact             { customInstructions? }
POST /api/auto-compaction     { enabled }

# Bash
POST /api/bash                { command }
POST /api/bash/abort

# Retry
POST /api/auto-retry          { enabled }
POST /api/auto-retry/abort

# Queue modes
POST /api/steering-mode       { mode: "all" | "one-at-a-time" }
POST /api/follow-up-mode      { mode: "all" | "one-at-a-time" }

# Discovery
GET  /api/commands

# Health (no auth)
GET  /health
```

REST returns 200 on **preflight ack** (pi confirms it accepted the command), not on completion. The body is pi's `data` field if any, else `{ ok: true }`. Async work — including model output, tool calls, and retries — is observed via the WebSocket event stream. `agent_end` is the completion signal.

Pi-side errors return 400 with `{ error: <pi's error string> }`. Bridge-side errors (timeout, pi crashed) return 503.

### WebSocket

```
GET /ws

server → client:
  - AgentEvents (turn_start, message_update, tool_execution_*, agent_end, ...)
  - extension_ui_request (notify, setStatus, setWidget, setTitle, confirm,
    select, input, editor — emitted when an extension calls ctx.ui.*)

client → server:
  - extension_ui_response (the only client→server message in v1)
```

Bearer token at handshake via the `Sec-WebSocket-Protocol` header as `bearer.<token>`. Server-side ping every 30s; clients that miss a pong are dropped.

Multi-client fan-out: every authenticated client receives every event. For interactive extension UI requests (`confirm` / `select` / `input` / `editor`), the bridge accepts the **first** `extension_ui_response` arriving from any client and drops subsequent ones for the same id. Fire-and-forget UI events (`notify`, `setStatus`, etc.) are pure broadcast — clients render them however they want without responding.

For protocol-level details, refer to [pi-mono's `rpc-types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts) — the bridge is a faithful pass-through.

---

## Deployment tiers

The bridge listens on a configurable bind address; how you expose it to clients is up to you. Five common patterns, in order of effort:

### Tier 1: Tailscale (~5 min, lowest friction)

Install Tailscale on your bridge host and on each client device. Set the bridge's `bindHost` to your tailnet IP. Done — Tailscale handles authenticated peer-to-peer connectivity, NAT traversal, encryption (WireGuard underneath), and ACLs.

**Trade-off:** Tailscale's coordination plane is hosted by Tailscale Inc. Identity goes through 3rd-party SSO. Data is end-to-end encrypted but metadata about your network is visible to Tailscale. Fine for personal homelab; less appealing if your threat model includes the Tailscale control plane.

### Tier 2: Headscale (~30 min, sovereign upgrade)

[Headscale](https://github.com/juanfont/headscale) is an open-source reimplementation of Tailscale's coordination server. Self-host it on your homelab (or on a small VPS). Tailscale's iOS / macOS / Linux clients all support a custom login server URL — point them at your Headscale instance and the rest of the experience is identical to Tier 1.

**Trade-off:** Same iOS NetworkExtension limitation as Tailscale (only one VPN active at a time). No 3rd-party metadata leak.

### Tier 3: mTLS over public internet (~1 hour, no overlay needed)

Bridge listens on the public internet behind a TLS terminator (Caddy / nginx / Traefik) configured for mutual TLS. Only clients presenting a valid certificate signed by your CA can complete the TLS handshake. The bridge itself stays on `127.0.0.1`.

```
# Caddyfile excerpt
bridge.example.com {
  tls {
    client_auth {
      mode require_and_verify
      trusted_ca_cert_file /etc/caddy/your-ca.pem
    }
  }
  reverse_proxy 127.0.0.1:8787
}
```

iOS / desktop clients install a `.p12` cert into the system keychain and use it on connect.

**Trade-off:** Public-internet attack surface (TLS layer fuzzing, DDoS noise), but with mTLS no attacker without a valid client cert ever talks to the bridge. Useful when you can't use a VPN — e.g., when an existing always-on VPN like ProtonVPN occupies the iOS slot.

### Tier 4: Self-hosted WireGuard + router-level upstream VPN (~half day, most sovereign)

A fully sovereign setup with no 3rd-party network overlay. Run a WireGuard server on your homelab router (GL.iNet / OpenWrt / Asus-Merlin / pfSense). Phone connects via WireGuard to your home network. The router optionally runs a privacy VPN (ProtonVPN, Mullvad, etc.) for upstream egress so all phone traffic gets that protection automatically when at home.

Bridge listens on the home LAN; phone reaches it as a regular local IP via the WireGuard tunnel.

**Trade-off:** Most setup. Best sovereignty story.

### Tier 5: Behind an authenticating reverse proxy (SMB / team)

For SMB or team deployments where you want SSO integration, audit, and centralized access policy. Deploy Authelia / oauth2-proxy / Pomerium / Cloudflare Access in front of the bridge. The reverse proxy handles auth, then forwards a pre-authenticated request.

**Note:** v0 only supports bearer-token auth. To use Tier 5 you currently configure the proxy to inject the same bearer token after its own auth succeeds. A native "trusted-proxy" mode (where the bridge accepts pre-auth via `X-Forwarded-User` from a configured upstream IP) is on the roadmap.

---

## Running as a long-running daemon

The bridge is meant to run continuously. The supervisor inside `index.ts` will auto-restart pi if it exits unexpectedly, but you'll want OS-level supervision for the bridge itself.

Both templates below use `/usr/local/bin/node` and `/usr/bin/node` as placeholders. **Replace these with the output of `which node` on your bridge host** — Apple Silicon Homebrew installs to `/opt/homebrew/bin/node`, nvm to `~/.nvm/versions/node/*/bin/node`, etc. Replace `/path/to/pi-rpc-bridge` with the actual clone location, and the `com.captcanadaman.*` label / `you` username with your own identifiers.

### macOS (launchd)

`~/Library/LaunchAgents/com.captcanadaman.pi-rpc-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.captcanadaman.pi-rpc-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/pi-rpc-bridge/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PI_RPC_BRIDGE_CONFIG_FILE</key>
    <string>/Users/you/.config/pi-rpc-bridge/config.json</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/pi-rpc-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/pi-rpc-bridge.err.log</string>
</dict>
</plist>
```

Load and start:
```bash
launchctl load ~/Library/LaunchAgents/com.captcanadaman.pi-rpc-bridge.plist
launchctl start com.captcanadaman.pi-rpc-bridge
```

### Linux (systemd)

`/etc/systemd/system/pi-rpc-bridge.service`:

```ini
[Unit]
Description=pi-rpc-bridge
After=network.target

[Service]
Type=simple
User=you
EnvironmentFile=/etc/pi-rpc-bridge/env
ExecStart=/usr/bin/node /opt/pi-rpc-bridge/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/pi-rpc-bridge/env`:
```
PI_RPC_BRIDGE_BEARER_TOKEN=...
PI_RPC_BRIDGE_CWD=/home/you/code/project
PI_RPC_BRIDGE_BIND_HOST=100.64.0.5
```

```bash
sudo chmod 600 /etc/pi-rpc-bridge/env
sudo chown you:you /etc/pi-rpc-bridge/env
sudo systemctl daemon-reload
sudo systemctl enable --now pi-rpc-bridge
journalctl -fu pi-rpc-bridge   # tail logs
```

---

## Uninstall

Stop the daemon (if you set one up), then remove the source tree, config, tokens, and logs. Pick the recipes that match how you installed.

### Stop the daemon

**macOS (launchd):**
```bash
launchctl unload ~/Library/LaunchAgents/com.captcanadaman.pi-rpc-bridge.plist
rm ~/Library/LaunchAgents/com.captcanadaman.pi-rpc-bridge.plist
```

**Linux (systemd):**
```bash
sudo systemctl disable --now pi-rpc-bridge
sudo rm /etc/systemd/system/pi-rpc-bridge.service
sudo rm -rf /etc/pi-rpc-bridge
sudo systemctl daemon-reload
```

### Remove source, config, tokens, and logs

```bash
# Source clone
rm -rf /path/to/pi-rpc-bridge

# Config + bearer token
rm -rf ~/.config/pi-rpc-bridge

# macOS log files (only if you used the default StandardOutPath/StandardErrorPath)
rm -f ~/Library/Logs/pi-rpc-bridge.log ~/Library/Logs/pi-rpc-bridge.err.log
```

### When published to npm (future)

If you installed via npm:
```bash
npm uninstall -g pi-rpc-bridge
```

### Important: this is **not** a pi extension

`pi-rpc-bridge` runs as a separate Node service that *spawns* pi as a subprocess. It is not installed via `pi install` and is not registered as a pi extension. **`pi uninstall pi-rpc-bridge` will not do anything useful** — pi has no record of the bridge ever existing. Use the recipes above.

---

## Troubleshooting

### `pi: command not found` on bridge startup
Pi isn't on `PATH` for the user running the bridge.
- Verify: `which pi && pi --version`
- Install if missing: `npm install -g @earendil-works/pi-coding-agent`
- Or set `PI_RPC_BRIDGE_PI_BIN=/full/path/to/pi` if pi is installed elsewhere

### `Bearer token must be at least 32 characters`
Your token is too short. Regenerate: `openssl rand -hex 32` produces 64 hex characters (256 bits).

### `Config file at X has overly-permissive mode`
The bridge refuses to load a config file readable by group or other (security: it contains your bearer token). Fix:
```bash
chmod 600 ~/.config/pi-rpc-bridge/config.json
```

### `pi working directory is required`
Set `PI_RPC_BRIDGE_CWD` to the directory pi should run in. The agent's tools (Read, Edit, Bash) operate relative to this path.

### Bridge starts but `POST /api/prompt` returns 503
Pi crashed or is restarting. The bridge auto-restarts pi after `restartBackoffMs` (default 2s); retry after a few seconds. Check the bridge's stderr — it tees pi's stderr inline (`[pi] ...` prefix). Common causes: pi misconfigured (no provider/model set), provider unreachable (Ollama not running, etc.).

### Bridge listening but clients can't connect
- Bind host: by default the bridge listens only on `127.0.0.1`. Set `PI_RPC_BRIDGE_BIND_HOST` to your overlay IP (e.g. Tailscale IP) for remote access.
- Firewall: confirm the bind port is reachable from the client's network.

### Auth always fails with 401
- Token mismatch: confirm the value you're sending matches what the bridge has loaded. Tokens drift after a config rotation; restart the bridge after editing.
- WebSocket: the token goes in `Sec-WebSocket-Protocol: bearer.<token>`, not `Authorization`. Most WebSocket libraries take an array of subprotocols at connect time.
- Origin: if you set `PI_RPC_BRIDGE_ALLOWED_ORIGINS`, browser clients must send a matching `Origin` header. Subdomain wildcards aren't supported.

### Bridge restarts pi every few seconds in a loop
Pi keeps crashing on startup. Run `pi --mode rpc` directly in the bridge's `cwd` to see why. Most common: missing provider config, missing API key in env.

---

## Development

```bash
npm install              # install dependencies
npm run check            # tsc --noEmit (type-check src + test)
npm run test             # vitest run (unit tests)
npm run test-tier2       # integration test — requires running bridge + Ollama
npm run build            # tsc → dist/
npm run start            # build + run the bridge
npm run ws-client        # CLI tool — connect to the WS and print events
npm run format           # biome format --write
npm run lint             # biome lint
```

### Project layout

```
src/
  index.ts          # entry — config, dependency graph, server start, signal handlers
  server.ts         # node:http + ws.WebSocketServer wiring; auth gate; route dispatch
  routes.ts         # Route type + findRoute exact-match dispatcher
  handlers/
    index.ts        # createRoutes() factory — all per-endpoint logic
  http-utils.ts     # JSON body reader, response helpers, ValidationError, withErrors
  pi-client.ts      # vendored RpcClient shim — spawn, JSONL, correlate, supervise
  jsonl.ts          # vendored verbatim from pi-mono
  ws-hub.ts         # connected-clients set, fan-out, extension UI routing
  ws-client.ts      # CLI test client for the WS endpoint
  auth.ts           # bearer-token validation (REST + WS subprotocol)
  config.ts         # config loading + validation
  types.ts          # vendored protocol types subset
test/
  jsonl.test.ts
  auth.test.ts
  routes.test.ts
  integration/
    tier2.ts        # extension UI routing smoke test (run via npm run test-tier2)
```

### Stack

- Node.js ≥20.6.0 (for `--env-file` support and modern WebSocket APIs)
- TypeScript with `strict` mode, ES2022, Node16 module resolution
- Single runtime dependency: `ws`. Everything else is from `node:` built-ins.
- Dev: Biome (formatter/linter), vitest (unit tests), tsx (run integration tests directly), typescript

The bridge does not depend on `@earendil-works/pi-coding-agent` or any pi-mono package. Protocol types and the JSONL helper are vendored — see `src/types.ts` and `src/jsonl.ts`. This keeps the install footprint small and decouples release cadence from upstream.

---

## What's out of scope (v0)

These are deliberate omissions, not oversights. Each has a planned solution path if/when it becomes a real need:

- **Multi-user.** Single bearer token, single user. The future SMB shape is per-user pi processes, not multi-user-per-bridge.
- **Multi-workspace per bridge.** Pi's `cwd` is fixed at process spawn. Run multiple bridge instances on different ports for now.
- **OAuth / SSO.** Tier 5 (reverse proxy) covers the team-deployment case for now.
- **Trusted-proxy auth mode** (bridge accepts pre-authenticated requests via `X-Forwarded-User`). On the roadmap once a real Tier 5 user drives requirements.
- **Rate limiting.** Single trusted user behind a known transport.
- **Telemetry / analytics.** None. Sovereignty default.
- **Persistent reconnection across bridge restarts.** Pi's session log on disk is the source of truth; clients re-snapshot on reconnect.

---

## Compatibility

- Tested 2026-05-03 against pi-coding-agent installed via `npm install -g @earendil-works/pi-coding-agent`.
- Smoke-tested with the [pi-ollama](https://github.com/CaptCanadaMan/pi-ollama) provider extension and a `nemotron-cascade-2:30b` model.
- Pi `--mode rpc` protocol is documented in [`rpc-types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts) and [`docs/rpc.md`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md). The bridge tracks that protocol; if pi-mono ships a breaking change, this project's vendored types will need a corresponding update.

---

## Contributing

Issues and PRs welcome. Style matches pi-mono's `biome.json` (tabs width 3, line width 120) and `AGENTS.md` (no emojis, no `any` outside justified spots, no inline imports). See [pi-mono's contribution guidelines](https://github.com/earendil-works/pi-mono/blob/main/CONTRIBUTING.md) for the broader ecosystem conventions.

## License

MIT. See [LICENSE](LICENSE).

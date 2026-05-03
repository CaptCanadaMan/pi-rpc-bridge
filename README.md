# pi-rpc-bridge

HTTP + WebSocket bridge for [`pi --mode rpc`](https://github.com/badlogic/pi-mono). Lets you drive a pi coding agent on your homelab from any client that speaks HTTPS, over a network layer of your choice (Tailscale, Headscale, mTLS-direct, self-hosted WireGuard, or behind an enterprise reverse proxy).

**Status:** Pre-alpha. Scaffold only — not yet functional.

## What this is

Pi-mono ships with an `--mode rpc` flag that exposes the agent over a JSON-lines protocol on stdin/stdout, designed for in-process embedding via TypeScript SDK. This bridge wraps that protocol in a small Node daemon so remote clients (mobile apps, web UIs, automation pipelines) can drive pi from anywhere.

The bridge is network-layer agnostic. It listens on a configurable bind address and authenticates with a bearer token; how you expose it to clients is your call. See the deployment ladder in the docs once they exist.

## What this is not

- An iOS app (separate project, coming later).
- A Tailscale dependency. Tailscale is one supported transport; not the only one.
- A pi-mono fork or extension. The bridge talks to a stock `pi --mode rpc` subprocess.

## Architecture

See `CLAUDE.md` for the full architecture briefing — process lifecycle, REST endpoint shape, WebSocket protocol, auth model, deployment tiers, and the rationale behind each.

## License

MIT. See `LICENSE`.

// Configuration loading and validation.
//
// Real implementation will load from:
//   - environment variables (Node 20.6+ supports `--env-file=` natively)
//   - optional config file at $XDG_CONFIG_HOME/pi-rpc-bridge/config.json
//     (chmod 600 enforced for the file containing the bearer token)
//
// Required config:
//   - bind address + port (default: 127.0.0.1:8787)
//   - bearer token
//   - pi cwd (working directory for the spawned pi process)
//   - pi binary path (default: `pi` from PATH)
//   - pi extra args (passed through to `pi --mode rpc`)
//
// Optional config:
//   - log level
//   - WS ping interval (default: 30s)
//   - pi supervisor restart backoff

export {};

// pi RpcClient shim — spawns `pi --mode rpc` as a child process, sends JSONL
// commands to its stdin, parses JSONL events / responses from its stdout,
// and correlates request/response pairs by id.
//
// Reference implementation: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts
// We vendor a minimal subset (~80 lines once implemented) rather than depending
// on @mariozechner/pi-coding-agent.
//
// Real implementation will:
//   - spawn pi with configured cwd, env, and CLI args
//   - attach jsonl reader to stdout (see jsonl.ts)
//   - maintain pendingRequests map for response correlation by id
//   - emit AgentEvents to subscribers via simple EventEmitter pattern
//   - expose typed methods for each RpcCommand we forward
//   - handle stderr collection for debugging
//   - graceful shutdown (SIGTERM → SIGKILL after 1s)
//   - supervisor restart hook (called by index.ts when pi exits)

export {};

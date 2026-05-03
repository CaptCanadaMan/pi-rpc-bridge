// Protocol types — subset of pi-mono's `rpc-types.ts` that the bridge actually touches.
//
// Source reference: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts
//
// We vendor a minimal subset rather than depending on @mariozechner/pi-coding-agent
// for types alone — that package pulls in the entire pi-mono dependency tree
// (pi-agent-core, pi-ai, pi-tui, photon-node WASM). For a pass-through bridge
// the cost is not justified.
//
// When pi-mono's protocol evolves, update this file to match. A protocol-conformance
// test in CI will eventually run a real `pi --mode rpc` and validate that our types
// still describe what we observe.
//
// TODO: populate with RpcCommand, RpcResponse, RpcSessionState, RpcExtensionUIRequest,
// RpcExtensionUIResponse, RpcSlashCommand. Imports of ImageContent / ThinkingLevel /
// AgentMessage / Model from pi-mono internal packages will be replaced with minimal
// local definitions or `unknown` for pass-through fields we don't manipulate.

export {};

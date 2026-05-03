// Protocol types — subset of pi-mono's `rpc-types.ts` that the bridge actually touches.
//
// Source reference: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts
//
// We type things we CONSTRUCT precisely (RpcCommand) so we can't build invalid
// commands. We leave things we FORWARD loose (event payloads, response data,
// session state) because the bridge doesn't manipulate them — it just JSON-stringifies
// and ships. Keeping these loose decouples our release cadence from pi-mono's
// internal type changes.
//
// When pi-mono's protocol evolves, only this file should need updating. A
// protocol-conformance test (TODO) will eventually run a real `pi --mode rpc`
// and verify our types still describe what we observe.

// ============================================================================
// Pass-through types (we don't introspect; pi validates)
// ============================================================================

export type ImageContent = unknown;

// ============================================================================
// RPC Commands — the bridge BUILDS these and writes them to pi's stdin
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id: string; type: "abort" }
	| { id: string; type: "new_session"; parentSession?: string }

	// State
	| { id: string; type: "get_state" }
	| { id: string; type: "get_messages" }
	| { id: string; type: "get_session_stats" }

	// Models
	| { id: string; type: "get_available_models" }
	| { id: string; type: "set_model"; provider: string; modelId: string }
	| { id: string; type: "cycle_model" }

	// Thinking
	| { id: string; type: "set_thinking_level"; level: string }
	| { id: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id: string; type: "compact"; customInstructions?: string }
	| { id: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id: string; type: "set_auto_retry"; enabled: boolean }
	| { id: string; type: "abort_retry" }

	// Bash
	| { id: string; type: "bash"; command: string }
	| { id: string; type: "abort_bash" }

	// Sessions
	| { id: string; type: "switch_session"; sessionPath: string }
	| { id: string; type: "fork"; entryId: string }
	| { id: string; type: "clone" }
	| { id: string; type: "get_fork_messages" }
	| { id: string; type: "get_last_assistant_text" }
	| { id: string; type: "set_session_name"; name: string }
	| { id: string; type: "export_html"; outputPath?: string }

	// Discovery
	| { id: string; type: "get_commands" };

export type RpcCommandType = RpcCommand["type"];

/** Distributive Omit — works with discriminated unions. */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** A command body without the auto-generated id. */
export type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

// ============================================================================
// RPC Response — pi's reply to a command, correlated by id.
// Loose typing because the bridge forwards `data` / `error` to clients verbatim.
// ============================================================================

export interface RpcResponse {
	id: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

// ============================================================================
// Events — anything pi emits on stdout that isn't a response.
// We forward verbatim. The bridge doesn't introspect event payloads.
// ============================================================================

export interface RpcEvent {
	type: string;
}

// ============================================================================
// Extension UI — the only interactive sub-protocol. Bridge routes by id.
// ============================================================================

/** Sent by pi when an extension calls ctx.ui.* . */
export interface RpcExtensionUIRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
}

/** Methods that EXPECT a response. Other methods (notify/setStatus/setWidget/setTitle/set_editor_text) are fire-and-forget. */
export const INTERACTIVE_UI_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

/** Sent by a WS client in response to an interactive request. Bridge forwards to pi's stdin. */
export interface RpcExtensionUIResponse {
	type: "extension_ui_response";
	id: string;
}

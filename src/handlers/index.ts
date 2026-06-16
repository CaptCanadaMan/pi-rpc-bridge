// HTTP route handlers.
//
// Each handler maps an HTTP request → an RpcCommand sent to pi → an HTTP response
// constructed from pi's preflight ack. Async work is observed via the WS event
// stream, not via the HTTP response.
//
// Response convention:
//   - pi responds success:true → HTTP 200, body is pi's `data` field if present, else `{ ok: true }`
//   - pi responds success:false → HTTP 400, body is `{ error: <pi's error string> }`
//   - piClient.send rejects (timeout, pi crashed) → HTTP 503, `{ error: <message> }`
//
// URL shape: simplified for v1. No session id in the path because pi has one
// active session at a time. Session-management endpoints sit under /api/session/*.
// When multi-session UX lands (v0.2+), :id-bearing routes can be added without
// breaking these.

import type { ServerResponse } from "node:http";
import type { PiClient } from "../pi-client.js";
import {
	asObject,
	optionalNumberField,
	optionalStringField,
	readJsonBody,
	requireBooleanField,
	requireStringField,
	sendError,
	sendJson,
	withErrors,
} from "../http-utils.js";
import type { Route } from "../routes.js";
import type { RpcCommandBody } from "../types.js";

export interface HandlerDeps {
	piClient: PiClient;
}

type PromptCommand = Extract<RpcCommandBody, { type: "prompt" }>;
type SteerCommand = Extract<RpcCommandBody, { type: "steer" }>;
type FollowUpCommand = Extract<RpcCommandBody, { type: "follow_up" }>;

// Bot-event delivery policy (#8). Urgent events (faults — low priority numbers)
// preempt the running turn (steer); routine progress events (nav arrived /
// blocked / recovered) queue after it (followUp). The threshold mirrors the
// sandbox priority bands (fault=10, operator=20, nav=30) — see pi-bot events.py.
const STEER_THRESHOLD = 20;

export function behaviorForPriority(priority: number | undefined): "steer" | "followUp" {
	return priority !== undefined && priority <= STEER_THRESHOLD ? "steer" : "followUp";
}

export function createRoutes(deps: HandlerDeps): Route[] {
	const { piClient } = deps;

	/** Send a typed command to pi, then write the HTTP response based on pi's reply. */
	async function execute(res: ServerResponse, command: RpcCommandBody): Promise<void> {
		let response;
		try {
			response = await piClient.send(command);
		} catch (err) {
			sendError(res, 503, (err as Error).message);
			return;
		}
		if (!response.success) {
			sendError(res, 400, response.error ?? "command failed");
			return;
		}
		sendJson(res, 200, response.data ?? { ok: true });
	}

	function readImagesField(body: Record<string, unknown>): unknown[] | undefined {
		return Array.isArray(body.images) ? body.images : undefined;
	}

	// ========================================================================
	// Prompting
	// ========================================================================

	const postPrompt = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const message = requireStringField(body, "message");
		const command: PromptCommand = { type: "prompt", message };
		const images = readImagesField(body);
		if (images) command.images = images;
		const sb = body.streamingBehavior;
		if (sb === "steer" || sb === "followUp") command.streamingBehavior = sb;
		await execute(res, command);
	});

	const postSteer = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const message = requireStringField(body, "message");
		const command: SteerCommand = { type: "steer", message };
		const images = readImagesField(body);
		if (images) command.images = images;
		await execute(res, command);
	});

	const postFollowUp = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const message = requireStringField(body, "message");
		const command: FollowUpCommand = { type: "follow_up", message };
		const images = readImagesField(body);
		if (images) command.images = images;
		await execute(res, command);
	});

	const postAbort = withErrors(async (_req, res) => {
		await execute(res, { type: "abort" });
	});

	// Bot-event injection (#8). The sandbox POSTs framed bot events here; we map
	// the priority band to a pi delivery discipline (steer vs followUp) and inject
	// as a prompt. A dedicated endpoint (vs /api/prompt) keeps bot-originated turns
	// observable and gives a forward-compat seam for per-user routing. The message
	// is already framed by the sandbox ("[bot event] ...") and forwarded as-is.
	const postEvent = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const message = requireStringField(body, "message");
		const priority = optionalNumberField(body, "priority");
		const command: PromptCommand = {
			type: "prompt",
			message,
			streamingBehavior: behaviorForPriority(priority),
		};
		await execute(res, command);
	});

	// ========================================================================
	// Session lifecycle
	// ========================================================================

	const postSessionNew = withErrors(async (req, res) => {
		const raw = await readJsonBody(req);
		let parentSession: string | undefined;
		if (raw !== undefined) {
			const body = asObject(raw);
			parentSession = optionalStringField(body, "parentSession");
		}
		await execute(
			res,
			parentSession ? { type: "new_session", parentSession } : { type: "new_session" },
		);
	});

	const postSessionSwitch = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const sessionPath = requireStringField(body, "sessionPath");
		await execute(res, { type: "switch_session", sessionPath });
	});

	const postSessionFork = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const entryId = requireStringField(body, "entryId");
		await execute(res, { type: "fork", entryId });
	});

	const postSessionClone = withErrors(async (_req, res) => {
		await execute(res, { type: "clone" });
	});

	const postSessionName = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const name = requireStringField(body, "name");
		await execute(res, { type: "set_session_name", name });
	});

	const postSessionExport = withErrors(async (req, res) => {
		const raw = await readJsonBody(req);
		let outputPath: string | undefined;
		if (raw !== undefined) {
			const body = asObject(raw);
			outputPath = optionalStringField(body, "outputPath");
		}
		await execute(
			res,
			outputPath ? { type: "export_html", outputPath } : { type: "export_html" },
		);
	});

	const getSessionState = withErrors(async (_req, res) => {
		await execute(res, { type: "get_state" });
	});

	const getSessionMessages = withErrors(async (_req, res) => {
		await execute(res, { type: "get_messages" });
	});

	const getSessionStats = withErrors(async (_req, res) => {
		await execute(res, { type: "get_session_stats" });
	});

	const getSessionForkable = withErrors(async (_req, res) => {
		await execute(res, { type: "get_fork_messages" });
	});

	const getSessionLastText = withErrors(async (_req, res) => {
		await execute(res, { type: "get_last_assistant_text" });
	});

	// ========================================================================
	// Models
	// ========================================================================

	const getModels = withErrors(async (_req, res) => {
		await execute(res, { type: "get_available_models" });
	});

	const postModel = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const provider = requireStringField(body, "provider");
		const modelId = requireStringField(body, "modelId");
		await execute(res, { type: "set_model", provider, modelId });
	});

	const postModelCycle = withErrors(async (_req, res) => {
		await execute(res, { type: "cycle_model" });
	});

	// ========================================================================
	// Thinking
	// ========================================================================

	const postThinkingLevel = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const level = requireStringField(body, "level");
		await execute(res, { type: "set_thinking_level", level });
	});

	const postThinkingLevelCycle = withErrors(async (_req, res) => {
		await execute(res, { type: "cycle_thinking_level" });
	});

	// ========================================================================
	// Compaction
	// ========================================================================

	const postCompact = withErrors(async (req, res) => {
		const raw = await readJsonBody(req);
		let customInstructions: string | undefined;
		if (raw !== undefined) {
			const body = asObject(raw);
			customInstructions = optionalStringField(body, "customInstructions");
		}
		await execute(
			res,
			customInstructions ? { type: "compact", customInstructions } : { type: "compact" },
		);
	});

	const postAutoCompaction = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const enabled = requireBooleanField(body, "enabled");
		await execute(res, { type: "set_auto_compaction", enabled });
	});

	// ========================================================================
	// Bash
	// ========================================================================

	const postBash = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const command = requireStringField(body, "command");
		await execute(res, { type: "bash", command });
	});

	const postBashAbort = withErrors(async (_req, res) => {
		await execute(res, { type: "abort_bash" });
	});

	// ========================================================================
	// Retry
	// ========================================================================

	const postAutoRetry = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const enabled = requireBooleanField(body, "enabled");
		await execute(res, { type: "set_auto_retry", enabled });
	});

	const postAutoRetryAbort = withErrors(async (_req, res) => {
		await execute(res, { type: "abort_retry" });
	});

	// ========================================================================
	// Queue modes
	// ========================================================================

	const postSteeringMode = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const mode = requireStringField(body, "mode");
		if (mode !== "all" && mode !== "one-at-a-time") {
			sendError(res, 400, "field 'mode' must be 'all' or 'one-at-a-time'");
			return;
		}
		await execute(res, { type: "set_steering_mode", mode });
	});

	const postFollowUpMode = withErrors(async (req, res) => {
		const body = asObject(await readJsonBody(req));
		const mode = requireStringField(body, "mode");
		if (mode !== "all" && mode !== "one-at-a-time") {
			sendError(res, 400, "field 'mode' must be 'all' or 'one-at-a-time'");
			return;
		}
		await execute(res, { type: "set_follow_up_mode", mode });
	});

	// ========================================================================
	// Discovery
	// ========================================================================

	const getCommands = withErrors(async (_req, res) => {
		await execute(res, { type: "get_commands" });
	});

	// ========================================================================
	// Health (unauthenticated — handled separately at server.ts before auth)
	// ========================================================================

	const getHealth = withErrors(async (_req, res) => {
		sendJson(res, 200, { status: "ok", piRunning: piClient.isRunning() });
	});

	// ========================================================================
	// Route table
	// ========================================================================

	return [
		// Prompting
		{ method: "POST", path: "/api/prompt", handler: postPrompt },
		{ method: "POST", path: "/api/steer", handler: postSteer },
		{ method: "POST", path: "/api/follow_up", handler: postFollowUp },
		{ method: "POST", path: "/api/abort", handler: postAbort },
		{ method: "POST", path: "/api/event", handler: postEvent },

		// Session lifecycle
		{ method: "POST", path: "/api/session/new", handler: postSessionNew },
		{ method: "POST", path: "/api/session/switch", handler: postSessionSwitch },
		{ method: "POST", path: "/api/session/fork", handler: postSessionFork },
		{ method: "POST", path: "/api/session/clone", handler: postSessionClone },
		{ method: "POST", path: "/api/session/name", handler: postSessionName },
		{ method: "POST", path: "/api/session/export", handler: postSessionExport },
		{ method: "GET", path: "/api/session/state", handler: getSessionState },
		{ method: "GET", path: "/api/session/messages", handler: getSessionMessages },
		{ method: "GET", path: "/api/session/stats", handler: getSessionStats },
		{ method: "GET", path: "/api/session/forkable", handler: getSessionForkable },
		{ method: "GET", path: "/api/session/last-text", handler: getSessionLastText },

		// Models
		{ method: "GET", path: "/api/models", handler: getModels },
		{ method: "POST", path: "/api/model", handler: postModel },
		{ method: "POST", path: "/api/model/cycle", handler: postModelCycle },

		// Thinking
		{ method: "POST", path: "/api/thinking-level", handler: postThinkingLevel },
		{ method: "POST", path: "/api/thinking-level/cycle", handler: postThinkingLevelCycle },

		// Compaction
		{ method: "POST", path: "/api/compact", handler: postCompact },
		{ method: "POST", path: "/api/auto-compaction", handler: postAutoCompaction },

		// Bash
		{ method: "POST", path: "/api/bash", handler: postBash },
		{ method: "POST", path: "/api/bash/abort", handler: postBashAbort },

		// Retry
		{ method: "POST", path: "/api/auto-retry", handler: postAutoRetry },
		{ method: "POST", path: "/api/auto-retry/abort", handler: postAutoRetryAbort },

		// Queue modes
		{ method: "POST", path: "/api/steering-mode", handler: postSteeringMode },
		{ method: "POST", path: "/api/follow-up-mode", handler: postFollowUpMode },

		// Discovery
		{ method: "GET", path: "/api/commands", handler: getCommands },

		// Health
		{ method: "GET", path: "/health", handler: getHealth },
	];
}

// Tier 2 extension UI routing integration smoke test.
//
// Drives the full bidirectional flow that distinguishes Tier 2 from a plain
// passthrough:
//   1. Connect to the bridge's /ws endpoint (bearer-token subprotocol)
//   2. POST /api/prompt with `/ollama-info` (no args) — pi-ollama's command
//      handler should call ctx.ui.select(), which pi turns into an
//      extension_ui_request with method "select"
//   3. Listen for that request on the WS
//   4. Send extension_ui_response back over the WS with the first option
//   5. Verify the resulting notify (model details) arrives
//
// This is an integration test — it requires a fully-running stack. Vitest
// won't auto-pick it up because the filename is `tier2.ts`, not
// `tier2.test.ts`. Run it explicitly via `npm run test-tier2`.
//
// Requires:
//   - pi-rpc-bridge running on PI_RPC_BRIDGE_URL (default http://127.0.0.1:8787)
//   - PI_RPC_BRIDGE_BEARER_TOKEN env var
//   - Ollama running with at least one model registered in pi-ollama
//   - pi-ollama installed with the /ollama-info no-args → select() patch
//
// Logs every WS event tag and the relevant fields so you can see exactly what
// flowed through the bridge.

import { WebSocket } from "ws";

const baseUrl = process.env.PI_RPC_BRIDGE_URL ?? "http://127.0.0.1:8787";
const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws`;
const token = process.env.PI_RPC_BRIDGE_BEARER_TOKEN;

if (!token) {
	console.error("PI_RPC_BRIDGE_BEARER_TOKEN env var required");
	process.exit(1);
}

const TIMEOUT_MS = 30_000;

type Stage = "connecting" | "waiting-for-select" | "waiting-for-notify" | "done";
let stage: Stage = "connecting";
let selectId: string | null = null;
let pickedValue: string | null = null;

const overallTimeout = setTimeout(() => {
	console.error(`FAIL: timed out (stage=${stage})`);
	process.exit(1);
}, TIMEOUT_MS);

const ws = new WebSocket(wsUrl, [`bearer.${token}`]);

ws.on("open", async () => {
	console.error(`WS connected → POST /api/prompt {"message":"/ollama-info"}`);
	stage = "waiting-for-select";

	const res = await fetch(`${baseUrl}/api/prompt`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ message: "/ollama-info" }),
	});

	const body = await res.text();
	console.error(`HTTP ${res.status}: ${body}`);
	if (!res.ok) {
		clearTimeout(overallTimeout);
		process.exit(1);
	}
});

ws.on("message", (data) => {
	const text = Buffer.isBuffer(data)
		? data.toString("utf8")
		: Array.isArray(data)
			? Buffer.concat(data).toString("utf8")
			: Buffer.from(data).toString("utf8");

	let event: {
		type?: string;
		method?: string;
		id?: string;
		options?: string[];
		message?: string;
		title?: string;
	};
	try {
		event = JSON.parse(text);
	} catch {
		return;
	}

	const tag = event.method ? `${event.type}/${event.method}` : event.type;
	console.error(`<= ${tag} ${event.id ?? ""}`);

	if (event.type === "extension_ui_request" && event.method === "select" && stage === "waiting-for-select") {
		selectId = event.id ?? null;
		const options = event.options ?? [];
		console.error(`   title=${JSON.stringify(event.title)} options=${JSON.stringify(options)}`);

		if (options.length === 0) {
			console.error("FAIL: select() with empty options — pi-ollama has no registered models");
			clearTimeout(overallTimeout);
			process.exit(1);
		}
		if (!selectId) {
			console.error("FAIL: select() request had no id");
			clearTimeout(overallTimeout);
			process.exit(1);
		}

		pickedValue = options[0];
		stage = "waiting-for-notify";
		console.error(`=> extension_ui_response id=${selectId} value=${JSON.stringify(pickedValue)}`);
		ws.send(
			JSON.stringify({
				type: "extension_ui_response",
				id: selectId,
				value: pickedValue,
			}),
		);
		return;
	}

	if (event.type === "extension_ui_request" && event.method === "notify") {
		const message = String(event.message ?? "");

		if (stage === "waiting-for-select") {
			if (message.includes("No Ollama models registered")) {
				console.error("FAIL: no models registered — run /ollama-refresh first");
			} else {
				console.error("FAIL: got notify instead of select() — pi-ollama may not have the no-args patch installed");
				const excerpt = message.length > 300 ? `${message.slice(0, 300)}...` : message;
				console.error(`     notify body: ${excerpt}`);
			}
			clearTimeout(overallTimeout);
			process.exit(1);
		}

		if (stage === "waiting-for-notify") {
			const excerpt = message.length > 200 ? `${message.slice(0, 200)}...` : message;
			console.error(`   notify excerpt: ${excerpt}`);
			// Pi-ollama options are decorated with capability flags
			// (e.g. "gemma4:26b   ctx:262,144  [tools, vision, reasoning]"). The
			// downstream notify only contains the bare model id, so check that.
			const pickedModelId = pickedValue ? pickedValue.split(/\s+/)[0] : null;
			if (pickedModelId && message.includes(pickedModelId)) {
				console.error(`PASS: tier 2 routing works end-to-end (select() → response → notify with details for ${pickedModelId})`);
			} else {
				console.error("PARTIAL: routing worked but notify content doesn't reference the picked model id");
				console.error("        (select request received, response forwarded, notify came back)");
			}
			stage = "done";
			clearTimeout(overallTimeout);
			ws.close();
			setTimeout(() => process.exit(0), 200).unref();
		}
	}
});

ws.on("error", (err: Error) => {
	console.error(`WS error: ${err.message}`);
	clearTimeout(overallTimeout);
	process.exit(1);
});

ws.on("close", () => {
	if (stage !== "done") {
		console.error(`WS closed during stage=${stage}`);
		process.exit(1);
	}
});

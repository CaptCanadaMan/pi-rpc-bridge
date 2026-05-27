// PiClient — spawns `pi --mode rpc` as a child process, frames JSONL on its
// stdin/stdout, correlates request/response by id, broadcasts events to listeners,
// and supervises pi with crash-restart.
//
// This is a vendored, minimal subset of pi-mono's `rpc-client.ts`. We don't
// depend on @earendil-works/pi-coding-agent because that package pulls in the
// whole pi-mono ecosystem (pi-agent-core, pi-ai, pi-tui, photon-node WASM)
// which is wildly disproportionate to our needs.
//
// Lifecycle:
//   1. start()                    spawns pi
//   2. on pi exit (unexpected)    auto-restart after restartBackoffMs (unless stopping)
//   3. stop()                     SIGTERM, then SIGKILL after 1s; suppresses restart
//
// Listeners receive every line that is NOT a successfully-routed response.
// Responses with unmatched ids are logged and dropped (don't leak to clients).

import { type ChildProcess, spawn } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type { RpcCommand, RpcCommandBody, RpcResponse } from "./types.js";

export interface PiClientOptions {
	binary: string;
	cwd: string;
	args: string[];
	env?: Record<string, string>;
	restartBackoffMs: number;
	responseTimeoutMs: number;
}

export type PiLineListener = (line: string, parsed: unknown) => void;

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	command: string;
}

const STDERR_BUFFER_LIMIT = 10_000;
const STDERR_BUFFER_TRIM = 5_000;
const SIGTERM_TIMEOUT_MS = 1000;

export class PiClient {
	private process: ChildProcess | null = null;
	private detachReader: (() => void) | null = null;
	private requestSeq = 0;
	private pending = new Map<string, PendingRequest>();
	private listeners = new Set<PiLineListener>();
	private stopping = false;
	private stderrBuffer = "";
	private restartTimer: NodeJS.Timeout | null = null;

	constructor(private opts: PiClientOptions) {}

	start(): void {
		if (this.process) {
			throw new Error("PiClient already started");
		}
		this.spawnPi();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		const child = this.process;
		if (!child) return;

		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, SIGTERM_TIMEOUT_MS);
			child.on("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	/** Subscribe to all lines pi emits that aren't successfully-routed responses. Returns unsubscribe. */
	onLine(listener: PiLineListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Send a typed RpcCommand and await pi's response (correlated by id). */
	async send(command: RpcCommandBody): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			throw new Error("pi process not running");
		}
		const id = `req_${++this.requestSeq}`;
		const full = { ...command, id } as RpcCommand;

		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type} (${this.opts.responseTimeoutMs}ms)`));
			}, this.opts.responseTimeoutMs);

			this.pending.set(id, { resolve, reject, timer, command: command.type });
			this.process!.stdin!.write(serializeJsonLine(full));
		});
	}

	/** Send an arbitrary line to pi's stdin (used to forward extension_ui_response from clients). */
	sendRaw(payload: unknown): void {
		if (!this.process?.stdin) {
			throw new Error("pi process not running");
		}
		this.process.stdin.write(serializeJsonLine(payload));
	}

	/** True if a pi child process is currently running. */
	isRunning(): boolean {
		return this.process !== null;
	}

	/** Most recent stderr from pi (capped to ~10KB). Useful for diagnostic responses. */
	getStderr(): string {
		return this.stderrBuffer;
	}

	private spawnPi(): void {
		if (this.stopping) return;

		const child = spawn(this.opts.binary, ["--mode", "rpc", ...this.opts.args], {
			cwd: this.opts.cwd,
			env: { ...process.env, ...this.opts.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (!child.stdin || !child.stdout || !child.stderr) {
			throw new Error("pi spawned without stdio streams");
		}

		this.process = child;
		this.stderrBuffer = "";

		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			this.stderrBuffer += text;
			if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
				this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_TRIM);
			}
			process.stderr.write(`[pi] ${text}`);
		});

		this.detachReader = attachJsonlLineReader(child.stdout, (line) => this.handleLine(line));

		child.on("error", (err) => {
			console.error(`[pi-client] spawn error: ${err.message}`);
		});

		child.on("exit", (code, signal) => {
			console.error(`[pi-client] pi exited (code=${code}, signal=${signal})`);
			this.detachReader?.();
			this.detachReader = null;
			this.process = null;

			// Reject any in-flight requests
			for (const [id, p] of this.pending) {
				clearTimeout(p.timer);
				p.reject(new Error(`pi exited (code=${code}, signal=${signal}) while waiting on ${p.command} [${id}]`));
			}
			this.pending.clear();

			if (!this.stopping) {
				console.error(`[pi-client] restarting in ${this.opts.restartBackoffMs}ms`);
				this.restartTimer = setTimeout(() => {
					this.restartTimer = null;
					this.spawnPi();
				}, this.opts.restartBackoffMs);
			}
		});
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Pi may print non-JSON preamble or stray output; ignore quietly.
			return;
		}

		if (typeof parsed === "object" && parsed !== null) {
			const obj = parsed as Record<string, unknown>;
			if (obj.type === "response" && typeof obj.id === "string") {
				const pending = this.pending.get(obj.id);
				if (pending) {
					clearTimeout(pending.timer);
					this.pending.delete(obj.id);
					pending.resolve(obj as unknown as RpcResponse);
					return;
				}
				// Response with unknown id — likely a stale reply after timeout. Log and drop.
				console.error(`[pi-client] dropped response for unknown id: ${obj.id}`);
				return;
			}
		}

		// Forward everything else (events + extension_ui_request) to listeners.
		for (const listener of this.listeners) {
			listener(line, parsed);
		}
	}
}

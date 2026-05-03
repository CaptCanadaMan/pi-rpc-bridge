// Configuration loading and validation.
//
// Sources, in priority order (highest first):
//   1. Environment variables (PI_RPC_BRIDGE_*) — all settings can be set this way
//   2. Optional config file (default: $XDG_CONFIG_HOME/pi-rpc-bridge/config.json)
//   3. Hardcoded defaults
//
// The bearer token MUST be provided (no default). Pi cwd MUST be provided
// (no default — this is the agent's working directory; we won't guess).
//
// Bearer token via env or config file only. Never accept it via CLI args
// (visible in process listings).

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
	bindHost: string;
	bindPort: number;
	bearerToken: string;
	pi: {
		cwd: string;
		binary: string;
		args: string[];
		restartBackoffMs: number;
		responseTimeoutMs: number;
	};
	ws: {
		pingIntervalMs: number;
		extensionRequestTtlMs: number;
	};
	logLevel: "debug" | "info" | "warn" | "error";
}

interface FileConfig {
	bindHost?: string;
	bindPort?: number;
	bearerToken?: string;
	pi?: {
		cwd?: string;
		binary?: string;
		args?: string[];
		restartBackoffMs?: number;
		responseTimeoutMs?: number;
	};
	ws?: {
		pingIntervalMs?: number;
		extensionRequestTtlMs?: number;
	};
	logLevel?: string;
}

const MIN_TOKEN_LENGTH = 32;
const VALID_LOG_LEVELS: ReadonlyArray<Config["logLevel"]> = ["debug", "info", "warn", "error"];

function defaultConfigPath(): string {
	const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(xdg, "pi-rpc-bridge", "config.json");
}

function loadFileConfig(path: string): FileConfig {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw new Error(`Cannot stat config file at ${path}: ${(err as Error).message}`);
	}

	// On POSIX, refuse if the file is group- or world-readable (token leak risk).
	// We compare mode bits 077 (group + other read/write/execute). Skip on Windows.
	if (process.platform !== "win32") {
		const mode = stat.mode & 0o077;
		if (mode !== 0) {
			throw new Error(
				`Config file at ${path} has overly-permissive mode (${(stat.mode & 0o777).toString(8)}). ` +
					`Run: chmod 600 ${path}`,
			);
		}
	}

	const content = readFileSync(path, "utf8");
	try {
		return JSON.parse(content) as FileConfig;
	} catch (err) {
		throw new Error(`Config file at ${path} is not valid JSON: ${(err as Error).message}`);
	}
}

function envInt(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n)) {
		throw new Error(`Env var ${name}=${raw} is not a valid integer`);
	}
	return n;
}

function requireString(value: string | undefined, source: string, advice: string): string {
	if (!value) {
		throw new Error(`${source} is required. ${advice}`);
	}
	return value;
}

export function loadConfig(): Config {
	const configPath = process.env.PI_RPC_BRIDGE_CONFIG_FILE ?? defaultConfigPath();
	const file = loadFileConfig(configPath);

	const bearerToken = requireString(
		process.env.PI_RPC_BRIDGE_BEARER_TOKEN ?? file.bearerToken,
		"Bearer token",
		`Set PI_RPC_BRIDGE_BEARER_TOKEN env var, or add "bearerToken" to ${configPath} (chmod 600). ` +
			`Generate one with: openssl rand -hex 32`,
	);
	if (bearerToken.length < MIN_TOKEN_LENGTH) {
		throw new Error(
			`Bearer token must be at least ${MIN_TOKEN_LENGTH} characters (got ${bearerToken.length}). ` +
				`Generate one with: openssl rand -hex 32`,
		);
	}

	const piCwd = requireString(
		process.env.PI_RPC_BRIDGE_CWD ?? file.pi?.cwd,
		"pi working directory",
		`Set PI_RPC_BRIDGE_CWD env var, or add "pi.cwd" to ${configPath}. ` +
			`This is the directory pi --mode rpc will run in.`,
	);

	const logLevelRaw = process.env.PI_RPC_BRIDGE_LOG_LEVEL ?? file.logLevel ?? "info";
	if (!(VALID_LOG_LEVELS as ReadonlyArray<string>).includes(logLevelRaw)) {
		throw new Error(`Invalid log level: ${logLevelRaw}. Must be one of: ${VALID_LOG_LEVELS.join(", ")}`);
	}

	return {
		bindHost: process.env.PI_RPC_BRIDGE_BIND_HOST ?? file.bindHost ?? "127.0.0.1",
		bindPort: envInt("PI_RPC_BRIDGE_BIND_PORT") ?? file.bindPort ?? 8787,
		bearerToken,
		pi: {
			cwd: piCwd,
			binary: process.env.PI_RPC_BRIDGE_PI_BIN ?? file.pi?.binary ?? "pi",
			args: file.pi?.args ?? [],
			restartBackoffMs: envInt("PI_RPC_BRIDGE_PI_RESTART_BACKOFF_MS") ?? file.pi?.restartBackoffMs ?? 2000,
			responseTimeoutMs: envInt("PI_RPC_BRIDGE_PI_RESPONSE_TIMEOUT_MS") ?? file.pi?.responseTimeoutMs ?? 30000,
		},
		ws: {
			pingIntervalMs: envInt("PI_RPC_BRIDGE_WS_PING_INTERVAL_MS") ?? file.ws?.pingIntervalMs ?? 30000,
			extensionRequestTtlMs:
				envInt("PI_RPC_BRIDGE_WS_EXT_REQUEST_TTL_MS") ?? file.ws?.extensionRequestTtlMs ?? 5 * 60 * 1000,
		},
		logLevel: logLevelRaw as Config["logLevel"],
	};
}

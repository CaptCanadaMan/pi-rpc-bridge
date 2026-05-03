// HTTP request/response helpers.
//
// Small utility surface — no framework, no middleware library. Each helper does
// one thing. Handlers compose them by hand.

import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB — covers prompts with embedded base64 images

/** Thrown when client-supplied data is malformed. Caught by `withErrors` → 400 response. */
export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

/**
 * Read and parse a JSON request body. Returns undefined for empty bodies (no Content-Length
 * or zero bytes received) so handlers with optional bodies can skip parsing without try/catch.
 * Throws ValidationError on parse failure or oversize.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
	const chunks: Buffer[] = [];
	let total = 0;

	for await (const chunk of req as AsyncIterable<Buffer>) {
		total += chunk.length;
		if (total > MAX_BODY_BYTES) {
			throw new ValidationError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
		}
		chunks.push(chunk);
	}

	if (chunks.length === 0) {
		return undefined;
	}

	const body = Buffer.concat(chunks).toString("utf8");
	try {
		return JSON.parse(body);
	} catch (err) {
		throw new ValidationError(`invalid JSON: ${(err as Error).message}`);
	}
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body ?? null);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(payload);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
	sendJson(res, status, { error: message });
}

export function sendNoContent(res: ServerResponse, status = 204): void {
	res.writeHead(status);
	res.end();
}

/** Wrap an async handler so thrown ValidationErrors become 400s and other errors become 500s. */
export function withErrors(
	handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) => {
		try {
			await handler(req, res);
		} catch (err) {
			if (res.headersSent) {
				// Already responded; nothing more we can do.
				return;
			}
			if (err instanceof ValidationError) {
				sendError(res, 400, err.message);
				return;
			}
			console.error("[http] handler error:", err);
			sendError(res, 500, (err as Error).message ?? "internal error");
		}
	};
}

/** Get pathname from req.url, stripping query string. */
export function getPathname(req: IncomingMessage): string {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	return url.pathname;
}

/** Narrow `body` to a non-null object, throwing ValidationError otherwise. */
export function asObject(body: unknown): Record<string, unknown> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ValidationError("body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

/** Get a required string field from a body object. */
export function requireStringField(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new ValidationError(`field '${key}' must be a non-empty string`);
	}
	return value;
}

/** Get an optional string field. */
export function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new ValidationError(`field '${key}' must be a string if provided`);
	}
	return value;
}

/** Get a required boolean field. */
export function requireBooleanField(body: Record<string, unknown>, key: string): boolean {
	const value = body[key];
	if (typeof value !== "boolean") {
		throw new ValidationError(`field '${key}' must be a boolean`);
	}
	return value;
}

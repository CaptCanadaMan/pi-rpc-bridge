// Route table + dispatcher.
//
// We don't use a router library. The endpoint set is small (~25 paths, all
// static for v1 — no path parameters), so an exact-match table is sufficient
// and fully testable in isolation.

import type { IncomingMessage, ServerResponse } from "node:http";

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface Route {
	method: string;
	path: string;
	handler: RouteHandler;
}

/** Find a route matching method + pathname. Returns null on miss. */
export function findRoute(routes: ReadonlyArray<Route>, method: string, pathname: string): Route | null {
	for (const r of routes) {
		if (r.method === method && r.path === pathname) {
			return r;
		}
	}
	return null;
}

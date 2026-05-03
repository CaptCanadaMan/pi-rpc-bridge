import { describe, expect, it } from "vitest";
import { findRoute, type Route } from "../src/routes.js";

const noop = async () => {};

const routes: Route[] = [
	{ method: "POST", path: "/api/prompt", handler: noop },
	{ method: "GET", path: "/api/session/state", handler: noop },
	{ method: "POST", path: "/api/abort", handler: noop },
];

describe("findRoute", () => {
	it("returns the route for an exact method+path match", () => {
		expect(findRoute(routes, "POST", "/api/prompt")).toBe(routes[0]);
		expect(findRoute(routes, "GET", "/api/session/state")).toBe(routes[1]);
	});

	it("returns null when method differs", () => {
		expect(findRoute(routes, "GET", "/api/prompt")).toBeNull();
		expect(findRoute(routes, "POST", "/api/session/state")).toBeNull();
	});

	it("returns null when path differs", () => {
		expect(findRoute(routes, "POST", "/api/promptx")).toBeNull();
		expect(findRoute(routes, "POST", "/api/")).toBeNull();
	});

	it("does not match by trailing slash", () => {
		expect(findRoute(routes, "POST", "/api/prompt/")).toBeNull();
	});

	it("does not match by case", () => {
		expect(findRoute(routes, "post", "/api/prompt")).toBeNull();
		expect(findRoute(routes, "POST", "/API/PROMPT")).toBeNull();
	});
});

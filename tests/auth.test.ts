import { describe, expect, test } from "bun:test";
import { ClaudeAuthError, isAuthError, shouldNotifyAuth } from "../src/auth.js";

describe("isAuthError", () => {
	test("detects Claude Code login-lost messages", () => {
		expect(isAuthError("Invalid API key · Please run /login")).toBe(true);
		expect(isAuthError("Not logged in · Please run /login")).toBe(true);
		expect(isAuthError("OAuth token has expired. Please obtain a new token or refresh your existing token.")).toBe(true);
		expect(isAuthError("authentication_failed")).toBe(true);
		expect(isAuthError("anything", 401)).toBe(true);
	});

	test("ignores unrelated errors", () => {
		expect(isAuthError("429 usage_limit_reached: hit your limit", 429)).toBe(false);
		expect(isAuthError("Claude Code process exited with code 1")).toBe(false);
		expect(isAuthError("MCP HTTP 401 from supabase tool output")).toBe(false);
	});
});

test("ClaudeAuthError carries status 401", () => {
	expect(new ClaudeAuthError("x").status).toBe(401);
});

test("notification is throttled", () => {
	const t = 10_000_000_000;
	expect(shouldNotifyAuth(t)).toBe(true);
	expect(shouldNotifyAuth(t + 1_000)).toBe(false);
	expect(shouldNotifyAuth(t + 61_000)).toBe(true);
});

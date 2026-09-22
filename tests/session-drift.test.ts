import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cc-"));
const mod = await import("../src/index.ts");
const T = (mod as any).__test;
const u = (t: string) => ({ role: "user", content: t, timestamp: 1 });
const a = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop", timestamp: 1 });
const cwd = process.env.CLAUDE_CONFIG_DIR!;

test("main path: shorter context than cursor REBUILDS with history (was: clean start, no history)", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: 9, cwd });
  const msgs = [u("plan"), a("here is the plan"), u("adelante")];   // 2 priors < cursor 9
  const r = T.syncSharedSession(msgs, cwd, undefined, "claude-sonnet-5", false);
  expect(r.sessionId).toBe("11111111-1111-4111-8111-111111111111"); // rebuilt in place
  expect(r.preserveSharedSession).toBeUndefined();
  expect(T.getSharedSession().cursor).toBe(2);
});

test("reentrant path: shorter context still gets a clean start and preserves shared session", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "22222222-2222-4222-8222-222222222222", cursor: 9, cwd });
  const r = T.syncSharedSession([u("sub task")], cwd, undefined, "claude-sonnet-5", true);
  expect(r.sessionId).toBeNull();
  expect(r.preserveSharedSession).toBe(true);
  expect(T.getSharedSession().cursor).toBe(9);
});

test("reuse path untouched: trailing assistant only", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "33333333-3333-4333-8333-333333333333", cursor: 2, cwd });
  const r = T.syncSharedSession([u("a"), a("b"), a("c"), u("d")], cwd, undefined, "claude-sonnet-5", false);
  expect(r.sessionId).toBe("33333333-3333-4333-8333-333333333333");
  expect(T.getSharedSession().cursor).toBe(3);
});

test("main path: zero priors with live shared session still preserves it", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "44444444-4444-4444-8444-444444444444", cursor: 9, cwd });
  const r = T.syncSharedSession([u("side request")], cwd, undefined, "claude-sonnet-5", false);
  expect(r.sessionId).toBeNull();
  expect(r.preserveSharedSession).toBe(true);
  expect(T.getSharedSession().cursor).toBe(9);
});

test("reentrant + needsRebuild never rebuilds the shared session", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "55555555-5555-4555-8555-555555555555", cursor: 9, cwd, needsRebuild: true });
  const r = T.syncSharedSession([u("a"), a("b"), u("c")], cwd, undefined, "claude-sonnet-5", true);
  expect(r.sessionId).toBeNull();
  expect(r.preserveSharedSession).toBe(true);
  expect(T.getSharedSession()).toMatchObject({ sessionId: "55555555-5555-4555-8555-555555555555", cursor: 9, needsRebuild: true });
});

test("main path + needsRebuild: rebuilds in place with full history", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "66666666-6666-4666-8666-666666666666", cursor: 9, cwd, needsRebuild: true });
  const r = T.syncSharedSession([u("a"), a("b"), u("c")], cwd, undefined, "claude-sonnet-5", false);
  expect(r.sessionId).toBe("66666666-6666-4666-8666-666666666666");
  expect(T.getSharedSession()).toEqual({ sessionId: "66666666-6666-4666-8666-666666666666", cursor: 2, cwd });
});

test("reentrant with no shared session yet: still a clean start, never publishes its own", () => {
  T.resetSharedSession();
  const r = T.syncSharedSession([u("a"), a("b"), u("c")], cwd, undefined, "claude-sonnet-5", true);
  expect(r.sessionId).toBeNull();
  expect(r.preserveSharedSession).toBe(true);
  // A subagent's history must not become the main conversation's session.
  expect(T.getSharedSession()).toBeNull();
});

test("reentrant never reuses the parent session, even when its history lines up", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "77777777-7777-4777-8777-777777777777", cursor: 2, cwd });
  // priors (2) >= cursor (2): this is exactly what the REUSE path accepts.
  const r = T.syncSharedSession([u("a"), a("b"), u("c")], cwd, undefined, "claude-sonnet-5", true);
  expect(r.sessionId).toBeNull();
  expect(r.preserveSharedSession).toBe(true);
  expect(T.getSharedSession()).toMatchObject({ sessionId: "77777777-7777-4777-8777-777777777777", cursor: 2 });
});

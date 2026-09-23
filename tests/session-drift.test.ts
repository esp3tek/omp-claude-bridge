import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { getSessionPath, readSession } from "cc-session-io";
const cwd = mkdtempSync(join(import.meta.dir, ".session-drift-"));
let previousConfigDir: string | undefined;
beforeEach(() => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cwd;
});
afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  T.resetSharedSession();
});
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
const mod = await import("../src/index.ts");
const T = (mod as any).__test;
const u = (t: string) => ({ role: "user", content: t, timestamp: 1 });
const a = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop", timestamp: 1 });
function importedContent(sessionId: string | null) {
  if (!sessionId) throw new Error("expected an imported child session");
  return readSession(getSessionPath(sessionId, cwd, cwd)).messages.map((record) => {
    const content = record.message.content;
    return typeof content === "string" ? content
      : content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  });
}

test("main path: shorter context than cursor REBUILDS with history (was: clean start, no history)", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: 9, cwd });
  const msgs = [u("plan"), a("here is the plan")];   // 2 priors < cursor 9
  const r = T.syncSharedSession(msgs, cwd, undefined, "claude-sonnet-5", false);
  expect(r.sessionId).toBe("11111111-1111-4111-8111-111111111111"); // rebuilt in place
  expect(r.preserveSharedSession).toBeUndefined();
  expect(T.getSharedSession().cursor).toBe(2);
});

test("reentrant path: zero priors start clean and preserve the shared session", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "22222222-2222-4222-8222-222222222222", cursor: 9, cwd });
  const r = T.syncSharedSession([], cwd, undefined, "claude-sonnet-5", true);
  expect(r.sessionId).toBeNull();
  expect(r.preserveSharedSession).toBe(true);
  expect(T.getSharedSession().cursor).toBe(9);
});

test("reuse path untouched: trailing assistant only", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "33333333-3333-4333-8333-333333333333", cursor: 2, cwd });
  const r = T.syncSharedSession([u("a"), a("b"), a("c")], cwd, undefined, "claude-sonnet-5", false);
  expect(r.sessionId).toBe("33333333-3333-4333-8333-333333333333");
  expect(T.getSharedSession().cursor).toBe(3);
});

test("main path: zero priors with live shared session still preserves it", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "44444444-4444-4444-8444-444444444444", cursor: 9, cwd });
  const r = T.syncSharedSession([], cwd, undefined, "claude-sonnet-5", false);
  expect(r.sessionId).toBeNull();
  expect(r.preserveSharedSession).toBe(true);
  expect(T.getSharedSession().cursor).toBe(9);
});

test("reentrant + needsRebuild imports its history without rebuilding the parent", () => {
  T.resetSharedSession();
  const shared = { sessionId: "55555555-5555-4555-8555-555555555555", cursor: 9, cwd, needsRebuild: true };
  T.setSharedSession(shared);
  const r = T.syncSharedSession([u("child question"), a("child answer")], cwd, undefined, "claude-sonnet-5", true);
  expect(r.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(r.sessionId).not.toBe(shared.sessionId);
  expect(r.preserveSharedSession).toBe(true);
  expect(importedContent(r.sessionId)).toEqual(["child question", "child answer"]);
  expect(T.getSharedSession()).toEqual(shared);
});

test("main path + needsRebuild: rebuilds in place with full history", () => {
  T.resetSharedSession();
  T.setSharedSession({ sessionId: "66666666-6666-4666-8666-666666666666", cursor: 9, cwd, needsRebuild: true });
  const r = T.syncSharedSession([u("a"), a("b")], cwd, undefined, "claude-sonnet-5", false);
  expect(r.sessionId).toBe("66666666-6666-4666-8666-666666666666");
  expect(T.getSharedSession()).toEqual({ sessionId: "66666666-6666-4666-8666-666666666666", cursor: 2, cwd });
});

test("reentrant with no shared session imports its own history without publishing it", () => {
  T.resetSharedSession();
  const r = T.syncSharedSession([u("child question"), a("child answer")], cwd, undefined, "claude-sonnet-5", true);
  expect(r.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(r.preserveSharedSession).toBe(true);
  expect(importedContent(r.sessionId)).toEqual(["child question", "child answer"]);
  expect(T.getSharedSession()).toBeNull();
});

test("reentrant never reuses the parent session, even when its history lines up", () => {
  T.resetSharedSession();
  const shared = { sessionId: "77777777-7777-4777-8777-777777777777", cursor: 2, cwd };
  T.setSharedSession(shared);
  // priors (2) >= cursor (2): this is exactly what the main REUSE path accepts.
  const r = T.syncSharedSession([u("child question"), a("child answer")], cwd, undefined, "claude-sonnet-5", true);
  expect(r.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(r.sessionId).not.toBe(shared.sessionId);
  expect(r.preserveSharedSession).toBe(true);
  expect(importedContent(r.sessionId)).toEqual(["child question", "child answer"]);
  expect(T.getSharedSession()).toEqual(shared);
});

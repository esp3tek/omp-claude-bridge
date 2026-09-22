import { test, expect } from "bun:test";
import { convertPiMessages, sanitizeToolId } from "../src/convert.ts";
const think = (t: string) => ({ type: "thinking", thinking: t, thinkingSignature: "sig-" + t });
const asst = (t: string, extra: any[] = []) => ({ role: "assistant", provider: "claude-bridge", content: [think(t), { type: "text", text: "answer " + t }, ...extra], timestamp: 1 });
const user = (t: string) => ({ role: "user", content: t, timestamp: 1 });
const msgs: any[] = [user("a"), asst("1"), user("b"), asst("2"), user("c"), asst("3")];
const countThinking = (r: any) => r.anthropicMessages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === "thinking").length;

test("last (default): only the final assistant turn keeps thinking", () => {
  const r = convertPiMessages(msgs, undefined);
  expect(countThinking(r)).toBe(1);
  expect(r.droppedThinking).toBe(2);
  const last = r.anthropicMessages[r.anthropicMessages.length - 1] as any;
  expect(last.content.find((b: any) => b.type === "thinking").thinking).toBe("3");
});
test("all: every thinking block is replayed (previous behaviour)", () => {
  const r = convertPiMessages(msgs, undefined, "all");
  expect(countThinking(r)).toBe(3);
  expect(r.droppedThinking).toBe(0);
});
test("none: no thinking replayed", () => {
  const r = convertPiMessages(msgs, undefined, "none");
  expect(countThinking(r)).toBe(0);
  expect(r.droppedThinking).toBe(3);
});
test("dropping thinking never empties an assistant message", () => {
  const r = convertPiMessages([user("a"), asst("1"), user("b"), asst("2")], undefined, "none");
  for (const m of r.anthropicMessages) if (m.role === "assistant") expect((m.content as any[]).length).toBeGreaterThan(0);
});

test("sanitizing tool ids gives lossy collisions unique, stable valid mappings", () => {
  const cache = new Map<string, string>();
  const usedIds = new Set<string>();
  const first = sanitizeToolId("call.a", cache, usedIds);
  const second = sanitizeToolId("call/a", cache, usedIds);

  expect(first).not.toBe(second);
  expect(sanitizeToolId("call.a", cache, usedIds)).toBe(first);
  expect([first, second].every((id) => /^[a-zA-Z0-9_-]+$/.test(id))).toBe(true);
});

test("sanitizing an available valid id preserves it", () => {
  const cache = new Map<string, string>();
  const usedIds = new Set<string>();

  expect(sanitizeToolId("toolu_01ABC-def", cache, usedIds)).toBe("toolu_01ABC-def");
});

test("sanitizing a valid id after its lossy equivalent keeps result pairing stable", () => {
  const cache = new Map<string, string>();
  const usedIds = new Set<string>();
  const lossyId = sanitizeToolId("call.a", cache, usedIds);
  const validId = sanitizeToolId("call_a", cache, usedIds);

  expect(validId).not.toBe(lossyId);
  expect(sanitizeToolId("call_a", cache, usedIds)).toBe(validId);
  expect(/^[a-zA-Z0-9_-]+$/.test(validId)).toBe(true);
});


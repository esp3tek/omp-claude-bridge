import { test, expect } from "bun:test";
import { convertPiMessages } from "../src/convert.ts";
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

import { sanitizeToolId } from "../src/convert.ts";

test("sanitizing tool ids never maps two different ids onto one", () => {
  const cache = new Map<string, string>();
  expect(sanitizeToolId("call.a", cache)).toBe("call_a");
  expect(sanitizeToolId("call/a", cache)).toBe("call_a_2");
  expect(sanitizeToolId("call.a", cache)).toBe("call_a"); // stable per id
  expect(new Set(cache.values()).size).toBe(cache.size);
});

test("an id that needs no substitution is passed through", () => {
  const cache = new Map<string, string>();
  expect(sanitizeToolId("toolu_01ABC-def", cache)).toBe("toolu_01ABC-def");
});

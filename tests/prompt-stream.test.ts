import { test, expect } from "bun:test";
import { makePromptStream, userMessage } from "../src/prompt-stream.ts";

const msg = (t: string) => userMessage([{ type: "text", text: t }] as any);

test("a push resolves once the consumer has taken it", async () => {
  const s = makePromptStream();
  const ack = s.push(msg("one"));
  const first = await s.stream.next();
  expect((first.value as any).message.content[0].text).toBe("one");
  const pending = s.stream.next(); // resuming past the yield is the ack
  await expect(ack).resolves.toBeUndefined();
  s.end();
  await pending;
});

test("abandoning the consumer settles every queued push instead of leaving it pending", async () => {
  const s = makePromptStream();
  const first = s.push(msg("one"));
  const second = s.push(msg("two"));
  await s.stream.next();          // park on the first
  await s.stream.return(undefined as any);  // consumer walks away
  await expect(first).rejects.toThrow();
  await expect(second).rejects.toThrow();   // used to hang until fail()
});

test("pushing after end rejects rather than hanging", async () => {
  const s = makePromptStream();
  s.end();
  await expect(s.push(msg("late"))).rejects.toThrow("prompt stream closed");
});

test("fail settles queued and in-flight pushes with its own error", async () => {
  const s = makePromptStream();
  const queued = s.push(msg("one"));
  s.fail(new Error("Operation aborted"));
  await expect(queued).rejects.toThrow("Operation aborted");
});

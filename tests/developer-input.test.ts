// omp "developer" messages (todo reminders, TTSR, stop nudges) must reach Claude
// Code as user content, marked as harness input, on every path: fresh query,
// session rebuild and resume. Before the fix a trailing developer message became
// the literal prompt "[continue]" and history rebuilds dropped it.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSession, repairToolPairing } from "cc-session-io";
import {
	DEVELOPER_OPEN, DEVELOPER_CLOSE, convertPiMessages, groupUserRuns, importMessagesLossless,
	promptMessageBlocks, splitPendingInput,
} from "../src/convert.ts";

process.env.CLAUDE_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), "cc-"));
const mod = await import("../src/index.ts");
const T = (mod as any).__test;
const cwd = process.env.CLAUDE_CONFIG_DIR!;

const u = (t: string) => ({ role: "user", content: t, timestamp: 1 });
const dev = (t: string) => ({ role: "developer", content: [{ type: "text", text: t }], timestamp: 1 });
const a = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop", timestamp: 1 });
const call = (...ids: string[]) => ({
	role: "assistant", stopReason: "toolUse", timestamp: 1,
	content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })),
});
const res = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError: false, timestamp: 1 });
const IMG = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
const REMINDER = "<system-reminder>\nYou stopped with 3 incomplete todo item(s)\n</system-reminder>";

const texts = (blocks: any[]) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("|");

test("developer text is wrapped as harness input, user text is not", () => {
	const d = promptMessageBlocks(dev("keep going"));
	expect(d).toEqual([{ type: "text", text: DEVELOPER_OPEN + "keep going" + DEVELOPER_CLOSE }]);
	expect(promptMessageBlocks(u("hola"))).toEqual([{ type: "text", text: "hola" }]);
	expect(promptMessageBlocks({ role: "developer", content: "plain string" })[0].text).toContain("plain string");
	expect(promptMessageBlocks({ role: "developer", content: [] })).toEqual([]);
});

test("developer image-only message keeps the image between the markers", () => {
	const d = promptMessageBlocks({ role: "developer", content: [IMG] });
	expect(d.map((b) => b.type)).toEqual(["text", "image", "text"]);
	expect((d[1] as any).source).toEqual({ type: "base64", media_type: "image/png", data: "aGVsbG8=" });
});

test("pending input: every user/developer after the last assistant, in order", () => {
	const msgs: any[] = [u("a"), a("b"), u("c"), dev("d1"), dev("d2")];
	const p = splitPendingInput(msgs);
	expect(p.pendingIndices).toEqual([2, 3, 4]);
	expect(p.history).toEqual([msgs[0], msgs[1]]);
	expect(p.interleaved).toBe(false);
	expect(texts(p.blocks)).toBe(["c", DEVELOPER_OPEN + "d1" + DEVELOPER_CLOSE, DEVELOPER_OPEN + "d2" + DEVELOPER_CLOSE].join("|"));
});

test("the real failing shape: tool result then reminder is a clean suffix", () => {
	const msgs: any[] = [u("a"), call("t1"), res("t1", "R1"), dev(REMINDER)];
	const p = splitPendingInput(msgs);
	expect(p.pendingIndices).toEqual([3]);
	expect(p.interleaved).toBe(false);
	expect(p.history.length).toBe(3);
	expect(texts(p.blocks)).toContain("incomplete todo");
});

test("reminder before a tool result is interleaved; `from` skips delivered input", () => {
	const msgs: any[] = [u("a"), call("t1", "t2"), res("t1", "R1"), dev("r"), res("t2", "R2")];
	const p = splitPendingInput(msgs);
	expect(p.pendingIndices).toEqual([3]);
	expect(p.interleaved).toBe(true);
	expect(splitPendingInput(msgs, 5).blocks).toEqual([]);
});

test("history rebuild keeps both real parallel results and the reminder", () => {
	const msgs: any[] = [u("a"), call("t1", "t2"), res("t1", "REAL1"), dev("mid reminder"), res("t2", "REAL2"), a("done")];
	const { anthropicMessages } = convertPiMessages(msgs, undefined);
	const repaired = repairToolPairing(anthropicMessages);
	const session = createSession({ projectPath: cwd, claudeDir: cwd });
	importMessagesLossless(session, repaired);
	session.save();
	const jsonl = readFileSync(session.jsonlPath, "utf8");
	expect(jsonl).toContain("REAL1");
	expect(jsonl).toContain("REAL2");
	expect(jsonl).toContain("mid reminder");
	expect(jsonl).not.toContain("no tool result recorded");
	// One user record after the tool call: results first, then the reminder.
	const users = session.messages.filter((r: any) => r.type === "user").map((r: any) => r.message.content);
	const afterCall = users[1] as any[];
	expect(afterCall.map((b) => b.type)).toEqual(["tool_result", "tool_result", "text"]);
});

test("rebuild keeps images and text next to tool results (cc-session-io importMessages dropped them)", () => {
	const msgs: any[] = [u("a"), call("t1"), res("t1", "R1"), { role: "developer", content: [{ type: "text", text: "look" }, IMG], timestamp: 1 }, a("ok")];
	const repaired = repairToolPairing(convertPiMessages(msgs, undefined).anthropicMessages);
	const session = createSession({ projectPath: cwd, claudeDir: cwd });
	importMessagesLossless(session, repaired);
	const blocks = (session.messages[2] as any).message.content as any[];
	expect(blocks.map((b) => b.type)).toEqual(["tool_result", "text", "image", "text"]);
});

test("groupUserRuns merges consecutive user turns and leaves single ones alone", () => {
	const out = groupUserRuns([
		{ role: "user", content: "x" },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r" }] },
		{ role: "assistant", content: [{ type: "text", text: "y" }] },
		{ role: "user", content: "z" },
	] as any);
	expect(out.length).toBe(3);
	expect((out[0].content as any[]).map((b) => b.type)).toEqual(["tool_result", "text"]);
	expect(out[2].content).toBe("z");
});

test("sync: trailing reminder after a delivered tool result resumes the session", () => {
	T.resetSharedSession();
	T.setSharedSession({ sessionId: "44444444-4444-4444-8444-444444444444", cursor: 3, cwd });
	const msgs: any[] = [u("a"), call("t1"), res("t1", "R1"), dev(REMINDER)];
	const r = T.syncSharedSession(msgs, cwd, undefined, "claude-sonnet-5", false, splitPendingInput(msgs));
	expect(r.sessionId).toBe("44444444-4444-4444-8444-444444444444");
	expect(T.getSharedSession().cursor).toBe(3);
});

test("sync: user prompt plus reminder after the final answer resumes (no rebuild for the extra message)", () => {
	T.resetSharedSession();
	T.setSharedSession({ sessionId: "55555555-5555-4555-8555-555555555555", cursor: 1, cwd });
	const msgs: any[] = [u("a"), a("b"), u("c"), dev("d")];
	const r = T.syncSharedSession(msgs, cwd, undefined, "claude-sonnet-5", false, splitPendingInput(msgs));
	expect(r.sessionId).toBe("55555555-5555-4555-8555-555555555555");
	expect(T.getSharedSession().cursor).toBe(2);
});

test("sync: interleaved input forces a rebuild that carries the tool results", () => {
	T.resetSharedSession();
	T.setSharedSession({ sessionId: "66666666-6666-4666-8666-666666666666", cursor: 5, cwd });
	const msgs: any[] = [u("a"), call("t1", "t2"), res("t1", "R1"), dev("r"), res("t2", "R2")];
	const r = T.syncSharedSession(msgs, cwd, undefined, "claude-sonnet-5", false, splitPendingInput(msgs));
	expect(r.sessionId).toBe("66666666-6666-4666-8666-666666666666");
	expect(T.getSharedSession().cursor).toBe(4); // history = 4 messages, reminder goes as the prompt
});

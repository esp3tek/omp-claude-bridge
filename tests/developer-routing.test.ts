import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createSession, getSessionPath, readSession } from "cc-session-io";
import type { AssistantMessageEventStream, Context, Model } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import { DEVELOPER_CLOSE, DEVELOPER_OPEN } from "../src/convert.ts";
import { resetStack } from "../src/query-state.ts";
import * as originalSdk from "@anthropic-ai/claude-agent-sdk";
import * as originalMcp from "../src/mcp-server.ts";
import * as originalOs from "os";
import * as originalHost from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type PromptMessage = { type: string; message: { role: string; content: Content[] }; priority?: string };
type ToolResult = { content: Content[]; isError?: boolean; toolCallId?: string };
type ToolHandler = (toolCallId: string) => Promise<ToolResult>;
type FakeMcpServer = { instance: { tools: Array<{ handler: ToolHandler }> } };
type QueryOptions = { mcpServers?: Record<string, FakeMcpServer>; resume?: string; persistSession?: boolean };
type QueryArgs = { prompt: AsyncIterable<PromptMessage> | string; options: QueryOptions };
type Run = (args: QueryArgs, query: FakeQuery) => AsyncGenerator<unknown>;
type FakeWarm = { query(prompt: QueryArgs["prompt"]): FakeQuery; close(): void };
type HostMessage = Record<string, unknown>;
type HostTool = { name: string; description: string; parameters: { type: "object"; properties: Record<string, never> } };

class Deferred<T> {
	#resolve!: (value: T) => void;
	readonly promise: Promise<T>;
	constructor() { this.promise = new Promise<T>((resolve) => { this.#resolve = resolve; }); }
	resolve(value: T) { this.#resolve(value); }
}

class FakeQuery {
	readonly closed = new Deferred<undefined>();
	readonly iterator: AsyncGenerator<unknown>;
	constructor(args: QueryArgs, run: Run) { this.iterator = run(args, this); }
	[Symbol.asyncIterator]() { return this.iterator; }
	interrupt() { return Promise.resolve(); }
	close() { this.closed.resolve(undefined); }
}

class FakeAssistantStream {
	readonly events: unknown[] = [];
	readonly ended = new Deferred<undefined>();
	push(event: unknown) { this.events.push(event); }
	end() { this.ended.resolve(undefined); }
}

const runs: Run[] = [];
const queryCalls: QueryArgs[] = [];
const queries: FakeQuery[] = [];
let startWarm: ((options: QueryOptions) => Promise<FakeWarm>) | undefined;
let synchronousQueryError: Error | undefined;
let catalogModels: Array<{ id: string; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }> = [];
const sdkModule = { ...originalSdk };
const hostModule = { ...originalHost };
const mcpModule = { ...originalMcp };
const osModule = { ...originalOs };

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	query: (args: QueryArgs) => {
		queryCalls.push(args);
		if (synchronousQueryError) throw synchronousQueryError;
		const run = runs.shift();
		if (!run) throw new Error("unexpected SDK query");
		const query = new FakeQuery(args, run);
		queries.push(query);
		return query;
	},
	// Most tests need no prewarm; cache tests provide a controllable warm handle.
	startup: ({ options }: { options: QueryOptions }) => startWarm?.(options) ?? Promise.reject(new Error("warm-up disabled in test")),
}));
mock.module("@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim", () => ({ ...hostModule, getModels: () => catalogModels }));
// The bridge still builds the production routing closure. This transport only
// exposes that closure to the simulated SDK without depending on MCP internals.
mock.module("../src/mcp-server.js", () => ({
	createToolServer: (name: string, tools: Array<{ handler: ToolHandler }>) => ({ type: "sdk", name, instance: { tools } }),
}));

const root = mkdtempSync(join(process.cwd(), ".developer-routing-"));
mkdirSync(join(root, ".omp", "agent"), { recursive: true });
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const previousDebug = process.env.CLAUDE_BRIDGE_DEBUG;
const previousNonessentialTraffic = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
process.env.CLAUDE_CONFIG_DIR = root;
process.env.CLAUDE_BRIDGE_DEBUG = "0";
// The pre-fix empty-developer regression emits an unconditional diagnostic.
// Keep every possible fixture artifact inside the repository temporary root.
mock.module("os", () => ({ ...osModule, homedir: () => root }));
// Static import cannot work: the module under test must observe the SDK mocks.
// This query string gives the routing fixture its own index evaluation: other
// test files load the normal extension before this test installs host mocks.
const { default: activateExtension, __test: T } = await import("../src/index.ts?developer-routing");
// The host stubs omit the stream class; this test supplies only its event sink.
const previousStreamFactory = T.setStreamFactory(() => new FakeAssistantStream() as unknown as AssistantMessageEventStream);

// These casts cross the mocked pi host boundary; every field source code reads is explicit.
const model = {
	id: "claude-sonnet-5", api: "anthropic-messages", provider: "anthropic",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<unknown>;
const tool: HostTool = { name: "echo", description: "test echo", parameters: { type: "object", properties: {} } };
const u = (text: string): HostMessage => ({ role: "user", content: text, timestamp: 1 });
const d = (text: string): HostMessage => ({ role: "developer", content: [{ type: "text", text }], timestamp: 1 });
const a = (id = "tool-1"): HostMessage => ({ role: "assistant", content: [{ type: "toolCall", id, name: "echo", arguments: {} }], stopReason: "toolUse", timestamp: 1 });
const result = (id = "tool-1", text = "tool result"): HostMessage => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError: false, timestamp: 1 });
const context = (messages: HostMessage[], tools: HostTool[] = []) => ({ messages, tools, systemPrompt: "" }) as unknown as Context;

function promptText(message: PromptMessage): string {
	return message.message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}
type ImportedSession = { path: string; companion: string; content: (string | unknown[])[] };
function importedSession(sessionId: string | undefined): ImportedSession | null {
	if (!sessionId) return null;
	const path = getSessionPath(sessionId, root, root);
	if (!existsSync(path)) return null;
	const content = readSession(path).messages.map((record) => record.message.content);
	const companion = join(dirname(path), sessionId);
	mkdirSync(companion, { recursive: true });
	writeFileSync(join(companion, "child-artifact"), "SDK artifact");
	return { path, companion, content };
}
function requireImported(session: ImportedSession | null): ImportedSession {
	if (!session) throw new Error("SDK did not see its imported child resume file");
	return session;
}

type ParentSession = { shared: { sessionId: string; cursor: number; cwd: string; needsRebuild: boolean; forceRotate: boolean }; path: string; bytes: string };
function parentSession() {
	const session = createSession({ projectPath: root, claudeDir: root });
	session.addUserMessage("parent history marker");
	session.addAssistantMessage([{ type: "text", text: "parent answered earlier" }]);
	session.save();
	const shared = { sessionId: session.sessionId, cursor: 2, cwd: root, needsRebuild: false, forceRotate: false };
	T.setSharedSession({ ...shared });
	return { shared, path: session.jsonlPath, bytes: readFileSync(session.jsonlPath, "utf8") };
}

async function holdParent(parent?: ParentSession) {
	const started = new Deferred<undefined>();
	runs.push(async function* ({ prompt }, query) {
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		started.resolve(undefined);
		await query.closed.promise;
	});
	const history = parent ? [
		u("parent history marker"),
		{ role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
	] : [];
	const stream = terminalEvent(T.streamClaudeAgentSdk(model, context([...history, u("parent active")]), { cwd: root }));
	await started.promise;
	if (parent) {
		expect(queryCalls[0]?.options.resume).toBe(parent.shared.sessionId);
		// Invalidation may arrive while the owning parent is still running.
		parent.shared.needsRebuild = true;
		parent.shared.forceRotate = true;
		T.setSharedSession({ ...parent.shared });
	}
	return stream;
}

function childHistory(withDelegation = true) {
	return [
		u("prior child task"), d("historical harness instruction"), a("child-tool"),
		result("child-tool", "real child tool output"),
		{ role: "assistant", content: [{ type: "text", text: "child answered earlier" }], stopReason: "stop", timestamp: 1 },
		...(withDelegation ? [u("new child delegation")] : []), d("current child reminder"),
	];
}
function expectChildHistory(content: (string | unknown[])[]) {
	const serialized = JSON.stringify(content);
	expect(serialized).toContain("prior child task");
	expect(serialized).toContain(JSON.stringify(`${DEVELOPER_OPEN}historical harness instruction${DEVELOPER_CLOSE}`).slice(1, -1));
	expect(serialized).toContain('"type":"tool_use"');
	expect(serialized).toContain('"id":"child-tool"');
	expect(serialized).toContain('"type":"tool_result"');
	expect(serialized).toContain('"tool_use_id":"child-tool"');
	expect(serialized).toContain("real child tool output");
	expect(serialized).toContain("child answered earlier");
	expect(serialized).not.toContain("new child delegation");
	expect(serialized).not.toContain("current child reminder");
}
function expectRemoved(sessionId: string | undefined) {
	if (!sessionId) throw new Error("expected isolated resume ID");
	const path = getSessionPath(sessionId, root, root);
	expect(existsSync(path)).toBe(false);
	expect(existsSync(join(dirname(path), sessionId))).toBe(false);
}

function expectParentUnchanged(parent: ParentSession) {
	expect(T.getSharedSession()).toEqual(parent.shared);
	expect(readFileSync(parent.path, "utf8")).toBe(parent.bytes);
}

function terminalEvent(stream: unknown): FakeAssistantStream {
	// The SDK-host mock creates this exact stream implementation.
	return stream as FakeAssistantStream;
}

function successRun(prompts: PromptMessage[], sessionId = "12345678-1234-4234-8234-123456789abc"): Run {
	return async function* ({ prompt }) {
		if (typeof prompt !== "string") prompts.push((await prompt[Symbol.asyncIterator]().next()).value);
		yield { type: "system", subtype: "init", session_id: sessionId };
		yield { type: "result", subtype: "success", result: "finished" };
	};
}

/** Simulates CC's concurrent stdin pump and MCP request. It resumes past the
 * developer yield before its handler resolves, which is the required FIFO. */
function toolRun(ids: string[], state: {
	prompts: PromptMessage[];
	results: ToolResult[];
	ready: Deferred<undefined>;
	delivered?: Deferred<undefined>;
	finish?: Deferred<undefined>;
	closeInput?: boolean;
	accepted?: Deferred<undefined>;
	ack?: Deferred<undefined>;
}): Run {
	return async function* ({ prompt, options }) {
		if (typeof prompt === "string") throw new Error("tool routing must receive the prompt stream");
		const input = prompt[Symbol.asyncIterator]();
		state.prompts.push((await input.next()).value);
		yield { type: "system", subtype: "init", session_id: "12345678-1234-4234-8234-123456789abc" };
		yield {
			type: "assistant",
			message: { content: ids.map((id) => ({ type: "tool_use", id, name: "mcp__custom-tools__echo", input: {} })) },
		};

		const server = options.mcpServers?.["custom-tools"];
		if (!server) throw new Error("bridge did not configure the MCP server");
		const handler = server.instance.tools[0]?.handler;
		if (!handler) throw new Error("bridge did not expose the MCP handler");
		if (state.closeInput) {
			await input.return(undefined);
			const pending = ids.map((id) => handler(id));
			state.ready.resolve(undefined);
			state.results.push(...await Promise.all(pending));
			state.delivered?.resolve(undefined);
		} else {
			const nextInput = input.next();
			const pending = ids.map((id) => handler(id).then((result) => {
				state.results.push(result);
				return result;
			}));
			state.ready.resolve(undefined);
			const steer = await nextInput;
			if (!steer.done) state.prompts.push(steer.value);
			state.accepted?.resolve(undefined);
			if (state.ack) await state.ack.promise;
			// PromptStream resolves push() only after this read resumes its yield.
			void input.next();
			await Promise.all(pending);
			state.delivered?.resolve(undefined);
		}
		if (state.finish) await state.finish.promise;
		yield { type: "result", subtype: "success", result: "finished" };
	};
}

beforeEach(() => {
	queryCalls.length = 0;
	queries.length = 0;
	runs.length = 0;
	synchronousQueryError = undefined;
	catalogModels = [];
	startWarm = undefined;
	T.clearSession();
	resetStack();
});

afterEach(async () => {
	for (const query of queries) query.close();
	T.getMainQueryContext().promptStream?.fail(new Error("test cleanup"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	T.clearSession();
	resetStack();
});

afterAll(() => {
	if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
	if (previousDebug === undefined) delete process.env.CLAUDE_BRIDGE_DEBUG;
	else process.env.CLAUDE_BRIDGE_DEBUG = previousDebug;
	if (previousNonessentialTraffic === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
	else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = previousNonessentialTraffic;
	rmSync(root, { recursive: true, force: true });
	mock.restore();
	T.setStreamFactory(previousStreamFactory);
	mock.module("@anthropic-ai/claude-agent-sdk", () => sdkModule);
	mock.module("../src/mcp-server.js", () => mcpModule);
	mock.module("@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim", () => hostModule);
	mock.module("os", () => osModule);
});

for (const streaming of [false, true]) {
	test(`provider emits per-response cost for an old zero-price Opus variant (streaming=${streaming})`, async () => {
		catalogModels = [{ id: "claude-opus-5-5", cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } }];
		const cached = { ...model, id: "claude-opus-5-5-1m", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		runs.push(async function* ({ prompt }) {
			if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
			yield { type: "system", subtype: "init", session_id: "12345678-1234-4234-8234-123456789abc" };
			const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 };
			if (streaming) {
				yield { type: "stream_event", event: { type: "message_start", message: { usage: { ...usage, output_tokens: 0 } } } };
				for (const output_tokens of [100, 200, 200]) {
					yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens } } };
				}
			}
			yield { type: "assistant", message: { content: [{ type: "text", text: "done" }], usage } };
			// Query/session totals must never become the cost of each individual response.
			yield { type: "result", subtype: "success", result: "done", total_cost_usd: 48.313 };
		});
		const stream = terminalEvent(T.streamClaudeAgentSdk(cached, context([u("cost test")]), { cwd: root }));
		await stream.ended.promise;
		expect(stream.events.at(-1)).toMatchObject({ type: "done", message: { usage: {
			input: 1000, output: 200, cacheRead: 10000, cacheWrite: 2000,
			cost: { input: 0.004, output: 0.004, cacheRead: 0.002, cacheWrite: 0.01, total: 0.02 },
		} } });
	});
}

test("a final developer message is an SDK prompt, wrapped as harness input", async () => {
	const prompts: PromptMessage[] = [];
	runs.push(successRun(prompts));
	const stream = terminalEvent(T.streamClaudeAgentSdk(model, context([u("start"), a(), d("final reminder")]), { cwd: root }));
	await stream.ended.promise;

	expect(prompts).toHaveLength(1);
	expect(promptText(prompts[0]!)).toContain(`${DEVELOPER_OPEN}final reminder${DEVELOPER_CLOSE}`);
	expect(stream.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
});

test("developer and user steers reach the SDK once, before the matching MCP result", async () => {
	const state = { prompts: [] as PromptMessage[], results: [] as ToolResult[], ready: new Deferred<undefined>(), delivered: new Deferred<undefined>(), finish: new Deferred<undefined>() };
	runs.push(toolRun(["tool-1"], state));
	T.streamClaudeAgentSdk(model, context([u("initial")], [tool]), { cwd: root });
	await state.ready.promise;

	const callbackContext = context([u("initial"), a(), d("reminder during tool"), u("and then user steer"), result()], [tool]);
	T.streamClaudeAgentSdk(model, callbackContext, { cwd: root });
	await state.delivered.promise;

	expect(state.prompts).toHaveLength(2);
	expect(promptText(state.prompts[1]!)).toContain(`${DEVELOPER_OPEN}reminder during tool${DEVELOPER_CLOSE}`);
	expect(promptText(state.prompts[1]!)).toContain("and then user steer");
	expect(state.results[0]?.content[0]?.text).toBe("tool result");

	// A repeated host callback can replay results, but never the input accepted by CC.
	T.streamClaudeAgentSdk(model, callbackContext, { cwd: root });
	expect(state.prompts).toHaveLength(2);
	state.finish.resolve(undefined);
	await queries[0]!.closed.promise;
});

test("a developer steer between two results is written before both MCP results", async () => {
	const state = { prompts: [] as PromptMessage[], results: [] as ToolResult[], ready: new Deferred<undefined>(), delivered: new Deferred<undefined>(), finish: new Deferred<undefined>() };
	runs.push(toolRun(["tool-1", "tool-2"], state));
	T.streamClaudeAgentSdk(model, context([u("initial")], [tool]), { cwd: root });
	await state.ready.promise;

	T.streamClaudeAgentSdk(model, context([
		u("initial"), a("tool-1"), result("tool-1", "first result"), d("developer between results"), result("tool-2", "second result"),
	], [tool]), { cwd: root });
	await state.delivered.promise;

	expect(state.prompts).toHaveLength(2);
	expect(promptText(state.prompts[1]!)).toContain(`${DEVELOPER_OPEN}developer between results${DEVELOPER_CLOSE}`);
	expect(state.results.map((entry) => entry.content[0]?.text)).toEqual(["first result", "second result"]);
	state.finish.resolve(undefined);
	await queries[0]!.closed.promise;
});

test("missing prompt stream marks the main shared session for rebuild", async () => {
	const state = { prompts: [] as PromptMessage[], results: [] as ToolResult[], ready: new Deferred<undefined>(), closeInput: true };
	const history = [u("earlier"), { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 1 }];
	T.setSharedSession({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: history.length, cwd: root });
	runs.push(toolRun(["tool-1"], state));
	T.streamClaudeAgentSdk(model, context([...history, u("initial")], [tool]), { cwd: root });
	await state.ready.promise;
	T.getMainQueryContext().promptStream = null;

	T.streamClaudeAgentSdk(model, context([...history, u("initial"), a(), d("lost reminder"), result()], [tool]), { cwd: root });
	await queries[0]!.closed.promise;
	expect(T.getSharedSession()).toMatchObject({ needsRebuild: true });
});

for (const missingStream of [false, true]) {
	test(`a first main query remembers a lost developer (${missingStream ? "missing stream" : "rejected push"})`, async () => {
		const state = { prompts: [] as PromptMessage[], results: [] as ToolResult[], ready: new Deferred<undefined>(), closeInput: true };
		runs.push(toolRun(["tool-1"], state));
		T.streamClaudeAgentSdk(model, context([u("initial")], [tool]), { cwd: root });
		await state.ready.promise;
		if (missingStream) T.getMainQueryContext().promptStream = null;

		T.streamClaudeAgentSdk(model, context([u("initial"), a(), d("lost reminder"), result()], [tool]), { cwd: root });
		await queries[0]!.closed.promise;
		expect(T.getSharedSession()).toMatchObject({ needsRebuild: true });
	});
}

test("a subagent's rejected developer push never marks its parent session", async () => {
	const parentStarted = new Deferred<undefined>();
	runs.push(async function* ({ prompt }, query) {
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		parentStarted.resolve(undefined);
		await query.closed.promise;
	});
	T.setSharedSession({ sessionId: "22222222-2222-4222-8222-222222222222", cursor: 7, cwd: root });
	T.streamClaudeAgentSdk(model, context([u("parent")]), { cwd: root });
	await parentStarted.promise;

	const child = { prompts: [] as PromptMessage[], results: [] as ToolResult[], ready: new Deferred<undefined>(), closeInput: true };
	runs.push(toolRun(["child-tool"], child));
	T.streamClaudeAgentSdk(model, context([u("child")], [tool]), { cwd: root });
	await child.ready.promise;
	T.streamClaudeAgentSdk(model, context([u("child"), a("child-tool"), d("child reminder"), result("child-tool")], [tool]), { cwd: root });
	await queries[1]!.closed.promise;

	expect(T.getSharedSession()).toEqual({ sessionId: "22222222-2222-4222-8222-222222222222", cursor: 7, cwd: root });
	queries[0]!.close();
});

test("an unrelated orphan result never erases an active parent's answer", async () => {
	const parentStarted = new Deferred<undefined>();
	runs.push(async function* ({ prompt }, query) {
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		yield { type: "assistant", message: { content: [{ type: "text", text: "parent answer retained" }] } };
		parentStarted.resolve(undefined);
		await query.closed.promise;
	});
	const parent = terminalEvent(T.streamClaudeAgentSdk(model, context([u("parent")]), { cwd: root }));
	await parentStarted.promise;

	const orphan = terminalEvent(T.streamClaudeAgentSdk(model, context([u("other"), a("foreign"), result("foreign")]), { cwd: root }));
	await orphan.ended.promise;
	expect(orphan.events.at(-1)).toMatchObject({ type: "done", message: { content: [] } });
	expect(queryCalls).toHaveLength(1);
	queries[0]!.close();
	await parent.ended.promise;
	expect(parent.events.at(-1)).toMatchObject({
		type: "done", message: { content: [{ type: "text", text: "parent answer retained" }] },
	});
});

test("a next query keeps its active routing context while the prior query finalizes", async () => {
	const firstPrompts: PromptMessage[] = [];
	runs.push(successRun(firstPrompts));
	const first = terminalEvent(T.streamClaudeAgentSdk(model, context([u("first")]), { cwd: root }));
	await first.ended.promise;

	const state = { prompts: [] as PromptMessage[], results: [] as ToolResult[], ready: new Deferred<undefined>(), delivered: new Deferred<undefined>() };
	runs.push(toolRun(["tool-2"], state));
	T.streamClaudeAgentSdk(model, context([u("second")], [tool]), { cwd: root });
	await state.ready.promise;
	T.streamClaudeAgentSdk(model, context([u("second"), a("tool-2"), d("second developer steer"), result("tool-2")], [tool]), { cwd: root });
	await state.delivered.promise;

	expect(promptText(state.prompts[1]!)).toContain(`${DEVELOPER_OPEN}second developer steer${DEVELOPER_CLOSE}`);
	expect(state.results[0]?.toolCallId).toBe("tool-2");
	await queries[1]!.closed.promise;
});

test("orphan result and developer shapes preserve end_turn; abort never starts a new query", async () => {
	const noInput = terminalEvent(T.streamClaudeAgentSdk(model, context([u("initial"), a(), result()]), { cwd: root }));
	await noInput.ended.promise;
	expect(noInput.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	expect(queryCalls).toHaveLength(0);

	const aborted = new AbortController();
	aborted.abort();
	for (const messages of [
		[u("initial"), a(), result(), d("developer after result")],
		[u("initial"), a(), d("developer before result"), result()],
		[u("initial"), a(), result(), d("")],
	]) {
		const stream = terminalEvent(T.streamClaudeAgentSdk(model, context(messages), { cwd: root, signal: aborted.signal }));
		await stream.ended.promise;
		expect(stream.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	}
	expect(queryCalls).toHaveLength(0);
});

test("repeated callbacks cannot release MCP results before the developer write is acknowledged", async () => {
	const state = {
		prompts: [] as PromptMessage[], results: [] as ToolResult[],
		ready: new Deferred<undefined>(), delivered: new Deferred<undefined>(),
		accepted: new Deferred<undefined>(), ack: new Deferred<undefined>(),
	};
	runs.push(toolRun(["tool-1"], state));
	T.streamClaudeAgentSdk(model, context([u("initial")], [tool]), { cwd: root });
	await state.ready.promise;
	const messages = context([u("initial"), a(), result(), d("pending write")], [tool]);
	const first = terminalEvent(T.streamClaudeAgentSdk(model, messages, { cwd: root }));
	await state.accepted.promise;
	const duplicate = terminalEvent(T.streamClaudeAgentSdk(model, messages, { cwd: root }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	try {
		expect(state.results).toEqual([]);
	} finally {
		state.ack.resolve(undefined);
	}
	await state.delivered.promise;
	await Promise.all([first.ended.promise, duplicate.ended.promise]);
	expect(state.prompts.map(promptText)).toEqual(["initial", `${DEVELOPER_OPEN}pending write${DEVELOPER_CLOSE}`]);
});

for (const childThrows of [false, true]) {
	test(`an aborted subagent does not invalidate the parent session (${childThrows ? "throw" : "return"})`, async () => {
		const parentReady = new Deferred<undefined>();
		runs.push(async function* (_args, query) {
			parentReady.resolve(undefined);
			await query.closed.promise;
		});
		const shared = { sessionId: "33333333-3333-4333-8333-333333333333", cursor: 7, cwd: root };
		T.setSharedSession(shared);
		T.streamClaudeAgentSdk(model, context([u("parent")]), { cwd: root });
		await parentReady.promise;
		const childReady = new Deferred<undefined>();
		runs.push(async function* (_args, query) {
			childReady.resolve(undefined);
			await query.closed.promise;
			if (childThrows) throw new Error("child abort");
		});
		const controller = new AbortController();
		const child = terminalEvent(T.streamClaudeAgentSdk(model, context([u("child")]), { cwd: root, signal: controller.signal }));
		await childReady.promise;
		controller.abort();
		await child.ended.promise;
		expect(child.events.at(-1)).toMatchObject({ type: "error", error: { stopReason: "aborted" } });
		expect(T.getSharedSession()).toEqual(shared);
	});
}

test("a side request with a lost steer preserves the unrelated shared session", async () => {
	const shared = { sessionId: "44444444-4444-4444-8444-444444444444", cursor: 7, cwd: root };
	T.setSharedSession(shared);
	const state = { prompts: [] as PromptMessage[], results: [] as ToolResult[], ready: new Deferred<undefined>(), closeInput: true };
	runs.push(toolRun(["side-tool"], state));
	T.streamClaudeAgentSdk(model, context([u("side request")], [tool]), { cwd: root });
	await state.ready.promise;
	T.streamClaudeAgentSdk(model, context([u("side request"), a("side-tool"), d("lost side steer"), result("side-tool")], [tool]), { cwd: root });
	await queries[0]!.closed.promise;
	expect(T.getSharedSession()).toEqual(shared);
});

for (const developerFirst of [false, true]) {
	test(`live orphan results replay history and deliver the developer (${developerFirst ? "before" : "after"} result)`, async () => {
		const prompts: PromptMessage[] = [];
		runs.push(successRun(prompts));
		const tail = developerFirst ? [d("orphan reminder"), result()] : [result(), d("orphan reminder")];
		const stream = terminalEvent(T.streamClaudeAgentSdk(model, context([u("initial"), a(), ...tail], [tool]), { cwd: root }));
		await stream.ended.promise;
		expect(stream.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(queryCalls).toHaveLength(1);
		expect(prompts.map(promptText)).toEqual([`${DEVELOPER_OPEN}orphan reminder${DEVELOPER_CLOSE}`]);
		const resume = queryCalls[0]!.options.resume;
		expect(resume).toBeDefined();
		const projectRoot = join(root, "projects");
		const sessionFile = readdirSync(projectRoot, { recursive: true }).map(String).find((file) => file.endsWith(`${resume}.jsonl`));
		expect(sessionFile).toBeDefined();
		const history = readFileSync(join(projectRoot, sessionFile!), "utf8");
		expect(history).toContain("tool result");
		expect(history).not.toContain("orphan reminder");
	});
}

test("an empty developer after an orphan result ends without starting a query", async () => {
	const stream = terminalEvent(T.streamClaudeAgentSdk(model, context([u("initial"), a(), result(), d("")]), { cwd: root }));
	await stream.ended.promise;
	expect(stream.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	expect(queryCalls).toHaveLength(0);
});

test("side requests neither discard nor replace the main conversation's warm process", async () => {
	let warmUses = 0;
	let warmCloses = 0;
	const warmPrompts: PromptMessage[] = [];
	startWarm = async (options) => ({
		query(prompt) {
			warmUses++;
			const query = new FakeQuery({ prompt, options }, successRun(warmPrompts));
			queries.push(query);
			return query;
		},
		close() { warmCloses++; },
	});
	runs.push(successRun([]));
	const initial = terminalEvent(T.streamClaudeAgentSdk(model, context([u("initial")]), { cwd: root }));
	await initial.ended.promise;
	await queries[0]!.closed.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));

	runs.push(async function* () { throw new Error("side failure"); });
	const failedSide = terminalEvent(T.streamClaudeAgentSdk(model, context([u("failed side")]), { cwd: root }));
	await failedSide.ended.promise;
	expect(failedSide.events.at(-1)).toMatchObject({ type: "error" });
	await queries[1]!.closed.promise;
	runs.push(successRun([], "55555555-5555-4555-8555-555555555555"));
	const side = terminalEvent(T.streamClaudeAgentSdk(model, context([u("successful side")]), { cwd: root }));
	await side.ended.promise;
	await queries[2]!.closed.promise;
	expect(warmUses).toBe(0);
	expect(warmCloses).toBe(0);

	const main = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("initial"), { role: "assistant", content: [{ type: "text", text: "finished" }], timestamp: 1 },
		u("next"), d("main reminder"),
	]), { cwd: root }));
	await main.ended.promise;
	expect(warmUses).toBe(1);
	expect(queryCalls).toHaveLength(3);
	expect(warmPrompts.map(promptText)).toEqual([`next\n${DEVELOPER_OPEN}main reminder${DEVELOPER_CLOSE}`]);
});

test("promptAndWait rebuilds all explicit history and sends only the delegation as new input", async () => {
	const history = [
		u("earlier"), { role: "assistant", content: [{ type: "text", text: "answered" }], timestamp: 1 },
		u("recent user"), d("recent harness"),
	];
	T.setSharedSession({ sessionId: "66666666-6666-4666-8666-666666666666", cursor: 2, cwd: process.cwd() });
	runs.push(successRun([]));
	const response = await T.promptAndWait("separate delegation", "none", new Map(), undefined, {
		history: context(history).messages,
	});
	expect(response).toEqual({ responseText: "finished", stopReason: "stop" });
	expect(queryCalls[0]!.prompt).toBe("separate delegation");
	const resume = queryCalls[0]!.options.resume;
	expect(resume).toBe("66666666-6666-4666-8666-666666666666");
	const projectRoot = join(root, "projects");
	const sessionFile = readdirSync(projectRoot, { recursive: true }).map(String).find((file) => file.endsWith(`${resume}.jsonl`));
	expect(sessionFile).toBeDefined();
	const imported = readFileSync(join(projectRoot, sessionFile!), "utf8");
	expect(imported).toContain("recent user");
	expect(imported).toContain("recent harness");
	expect(imported).not.toContain("separate delegation");
});

test("all pending messages reach the SDK, including an image-only developer", async () => {
	const prompts: PromptMessage[] = [];
	runs.push(successRun(prompts));
	const stream = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("user input"), d("text reminder"),
		{ role: "developer", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 1 },
	]), { cwd: root }));
	await stream.ended.promise;
	expect(prompts[0]!.message.content).toEqual([
		{ type: "text", text: "user input" },
		{ type: "text", text: `${DEVELOPER_OPEN}text reminder${DEVELOPER_CLOSE}` },
		{ type: "text", text: DEVELOPER_OPEN.trimEnd() },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
		{ type: "text", text: DEVELOPER_CLOSE.trimStart() },
	]);
});

test("a side request preserves a parent's pending post-abort rebuild", async () => {
	const shared = {
		sessionId: "77777777-7777-4777-8777-777777777777", cursor: 7, cwd: root,
		needsRebuild: true, forceRotate: true,
	};
	T.setSharedSession(shared);
	runs.push(successRun([]));
	const side = terminalEvent(T.streamClaudeAgentSdk(model, context([u("side request")]), { cwd: root }));
	await side.ended.promise;
	expect(T.getSharedSession()).toEqual(shared);
});

test("a mid-run compaction's shorter context still delivers its new tool results", async () => {
	// Seen live: omp compacted between provider calls, the callback carried a context
	// shorter than the one last delivered, the bridge took it for a duplicate, and omp
	// got three empty stops while Claude Code waited on the tool call forever.
	const state = { prompts: [] as PromptMessage[], results: [] as ToolResult[], ready: new Deferred<undefined>(), delivered: new Deferred<undefined>(), finish: new Deferred<undefined>() };
	runs.push(toolRun(["tool-1"], state));
	T.streamClaudeAgentSdk(model, context([u("initial")], [tool]), { cwd: root });
	await state.ready.promise;
	T.getMainQueryContext().latestCursor = 40; // a long pre-compaction context was delivered before

	// The reminder after the result also proves the input cursor was reset: with the
	// stale cursor (40) it sat "before" the delivered position and was never sent.
	const compacted = context([u("summary of the compacted history"), a(), result("tool-1", "after compaction"), d("post-compaction reminder")], [tool]);
	const stream = terminalEvent(T.streamClaudeAgentSdk(model, compacted, { cwd: root }));
	await state.delivered.promise;
	expect(state.results).toHaveLength(1);
	expect(JSON.stringify(state.results[0])).toContain("after compaction");
	expect(promptText(state.prompts[1]!)).toContain(`${DEVELOPER_OPEN}post-compaction reminder${DEVELOPER_CLOSE}`);

	// The same callback again is a real duplicate: nothing new to hand over.
	const again = terminalEvent(T.streamClaudeAgentSdk(model, compacted, { cwd: root }));
	await again.ended.promise;
	expect(state.results).toHaveLength(1);
	state.finish.resolve(undefined);
	await stream.ended.promise;
});

test("active parent keeps its shared session while a child resumes full history and reminder, then removes its own artifacts without init", async () => {
	const parent = parentSession();
	const parentStream = await holdParent(parent);
	try {
		const started = new Deferred<undefined>();
		const finish = new Deferred<undefined>();
		let imported: ImportedSession | null = null;
		const prompts: PromptMessage[] = [];
		runs.push(async function* ({ prompt, options }) {
			imported = importedSession(options.resume);
			if (typeof prompt !== "string") prompts.push((await prompt[Symbol.asyncIterator]().next()).value);
			started.resolve(undefined);
			await finish.promise;
			yield { type: "result", subtype: "success", result: "child done without init" };
		});
		const child = terminalEvent(T.streamClaudeAgentSdk(model, context(childHistory(false), [tool]), { cwd: root }));
		await started.promise;
		try {
			const resume = queryCalls[1]?.options.resume;
			expect(resume).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			expect(resume).not.toBe(parent.shared.sessionId);
			expectChildHistory(requireImported(imported).content);
			expect(prompts.map(promptText)).toEqual([`${DEVELOPER_OPEN}current child reminder${DEVELOPER_CLOSE}`]);
			expectParentUnchanged(parent);
			expect(existsSync(requireImported(imported).companion)).toBe(true);
		} finally {
			finish.resolve(undefined);
		}
		await child.ended.promise;
		await queries[1]!.closed.promise;
		expect(child.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expectRemoved(queryCalls[1]?.options.resume);
		expectParentUnchanged(parent);
	} finally {
		queries[0]?.close();
		await parentStream.ended.promise;
	}
});

test("active parent without a shared session stays unpublished while a child receives full imported history", async () => {
	const parentStream = await holdParent();
	try {
		const started = new Deferred<undefined>();
		const finish = new Deferred<undefined>();
		let imported: ImportedSession | null = null;
		const capturedId = "81234567-1234-4234-8234-123456789abc";
		const prompts: PromptMessage[] = [];
		runs.push(async function* ({ prompt, options }) {
			imported = importedSession(options.resume);
			if (typeof prompt !== "string") prompts.push((await prompt[Symbol.asyncIterator]().next()).value);
			const captured = createSession({ projectPath: root, claudeDir: root, sessionId: capturedId });
			captured.addUserMessage("SDK captured session artifact");
			captured.save();
			mkdirSync(join(dirname(captured.jsonlPath), capturedId), { recursive: true });
			started.resolve(undefined);
			await finish.promise;
			yield { type: "system", subtype: "init", session_id: capturedId };
			yield { type: "result", subtype: "success", result: "child done" };
		});
		const child = terminalEvent(T.streamClaudeAgentSdk(model, context(childHistory(), [tool]), { cwd: root }));
		await started.promise;
		try {
			const resume = queryCalls[1]?.options.resume;
			expect(resume).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			expect(resume).not.toBe(capturedId);
			expectChildHistory(requireImported(imported).content);
			expect(prompts.map(promptText)).toEqual([`new child delegation\n${DEVELOPER_OPEN}current child reminder${DEVELOPER_CLOSE}`]);
			expect(T.getSharedSession()).toBeNull();
		} finally {
			finish.resolve(undefined);
		}
		await child.ended.promise;
		expect(child.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		await queries[1]!.closed.promise;
		expectRemoved(queryCalls[1]?.options.resume);
		expectRemoved(capturedId);
		expect(T.getSharedSession()).toBeNull();
	} finally {
		queries[0]?.close();
		await parentStream.ended.promise;
	}
});

test("child iterator error before init removes imported history without changing its active parent", async () => {
	const parent = parentSession();
	const parentStream = await holdParent(parent);
	try {
		let imported: ImportedSession | null = null;
		runs.push(async function* ({ options }) {
			imported = importedSession(options.resume);
			throw new Error("child iterator failed before init");
		});
		const child = terminalEvent(T.streamClaudeAgentSdk(model, context(childHistory(), [tool]), { cwd: root }));
		await child.ended.promise;
		expect(child.events.at(-1)).toMatchObject({ type: "error" });
		await queries[1]!.closed.promise;
		expectChildHistory(requireImported(imported).content);
		expectRemoved(queryCalls[1]?.options.resume);
		expectParentUnchanged(parent);
	} finally {
		queries[0]?.close();
		await parentStream.ended.promise;
	}
});

test("aborting a child removes both imported history and a different captured SDK session", async () => {
	const parent = parentSession();
	const parentStream = await holdParent(parent);
	try {
		const started = new Deferred<undefined>();
		const capturedId = "91234567-1234-4234-8234-123456789abc";
		let imported: ImportedSession | null = null;
		runs.push(async function* ({ options }, query) {
			imported = importedSession(options.resume);
			const captured = createSession({ projectPath: root, claudeDir: root, sessionId: capturedId });
			captured.addUserMessage("SDK captured before child abort");
			captured.save();
			mkdirSync(join(dirname(captured.jsonlPath), capturedId), { recursive: true });
			yield { type: "system", subtype: "init", session_id: capturedId };
			started.resolve(undefined);
			await query.closed.promise;
		});
		const controller = new AbortController();
		const child = terminalEvent(T.streamClaudeAgentSdk(model, context(childHistory(), [tool]), { cwd: root, signal: controller.signal }));
		await started.promise;
		try {
			expectChildHistory(requireImported(imported).content);
			expect(queryCalls[1]?.options.resume).not.toBe(parent.shared.sessionId);
			expectParentUnchanged(parent);
		} finally {
			controller.abort();
		}
		await child.ended.promise;
		await queries[1]!.closed.promise;
		expect(child.events.at(-1)).toMatchObject({ type: "error", error: { stopReason: "aborted" } });
		expectRemoved(queryCalls[1]?.options.resume);
		expectRemoved(capturedId);
		expectParentUnchanged(parent);
	} finally {
		queries[0]?.close();
		await parentStream.ended.promise;
	}
});

test("a synchronous SDK query throw removes the imported child session and companion", async () => {
	const parent = parentSession();
	const parentStream = await holdParent(parent);
	try {
		synchronousQueryError = new Error("SDK query setup failed");
		expect(() => T.streamClaudeAgentSdk(model, context(childHistory(), [tool]), { cwd: root }))
			.toThrow("SDK query setup failed");
		expect(queryCalls[1]?.options.resume).not.toBe(parent.shared.sessionId);
		expectRemoved(queryCalls[1]?.options.resume);
		expectParentUnchanged(parent);
	} finally {
		synchronousQueryError = undefined;
		queries[0]?.close();
		await parentStream.ended.promise;
	}
});

for (const failure of ["iterator error", "abort"] as const) {
	test(`zero-prior side request cleans a captured SDK session on ${failure} without touching the active parent`, async () => {
		const parent = parentSession();
		const parentStream = await holdParent(parent);
		try {
			const capturedId = failure === "abort" ? "a1234567-1234-4234-8234-123456789abc" : "b1234567-1234-4234-8234-123456789abc";
			const started = new Deferred<undefined>();
			runs.push(async function* (_args, query) {
				const captured = createSession({ projectPath: root, claudeDir: root, sessionId: capturedId });
				captured.addUserMessage("SDK zero-prior artifact");
				captured.save();
				mkdirSync(join(dirname(captured.jsonlPath), capturedId), { recursive: true });
				yield { type: "system", subtype: "init", session_id: capturedId };
				started.resolve(undefined);
				if (failure === "abort") await query.closed.promise;
				else throw new Error("zero-prior SDK iteration failed");
			});
			const controller = new AbortController();
			const child = terminalEvent(T.streamClaudeAgentSdk(model, context([u("new side request")]), { cwd: root, signal: controller.signal }));
			await started.promise;
			expect(queryCalls[1]?.options.resume).toBeUndefined();
			if (failure === "abort") controller.abort();
			await child.ended.promise;
			await queries[1]!.closed.promise;
			expect(child.events.at(-1)).toMatchObject({ type: "error", error: { stopReason: failure === "abort" ? "aborted" : "error" } });
			expectRemoved(capturedId);
			expectParentUnchanged(parent);
		} finally {
			queries[0]?.close();
			await parentStream.ended.promise;
		}
	});
}

test("a history-bearing child leaves its active parent's warmed SDK process intact", async () => {
	let warmUses = 0;
	let warmCloses = 0;
	const parentStarted = new Deferred<undefined>();
	startWarm = async (options) => ({
		query(prompt) {
			warmUses++;
			const query = new FakeQuery({ prompt, options }, async function* (_args, active) {
				parentStarted.resolve(undefined);
				await active.closed.promise;
			});
			queries.push(query);
			return query;
		},
		close() { warmCloses++; },
	});
	runs.push(successRun([]));
	const initial = terminalEvent(T.streamClaudeAgentSdk(model, context([u("first parent turn")]), { cwd: root }));
	await initial.ended.promise;
	await queries[0]!.closed.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	runs.push(async function* (_args, active) {
		parentStarted.resolve(undefined);
		await active.closed.promise;
	});
	const parent = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("first parent turn"),
		{ role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop", timestamp: 1 },
		u("second parent turn"),
	]), { cwd: root }));
	try {
		await parentStarted.promise;
		expect(warmUses).toBe(1);
		// The fallback only prevents a failed warm lookup from parking the test.
		runs.shift();
		const shared = T.getSharedSession();
		let imported: ImportedSession | null = null;
		runs.push(async function* ({ options }) {
			imported = importedSession(options.resume);
			yield { type: "result", subtype: "success", result: "child done" };
		});
		const child = terminalEvent(T.streamClaudeAgentSdk(model, context(childHistory(), [tool]), { cwd: root }));
		await child.ended.promise;
		await queries[2]!.closed.promise;
		expectChildHistory(requireImported(imported).content);
		expectRemoved(queryCalls[1]?.options.resume);
		expect(warmUses).toBe(1);
		expect(warmCloses).toBe(0);
		expect(T.getSharedSession()).toEqual(shared);
	} finally {
		queries[1]?.close();
		await parent.ended.promise;
	}
});

const recapMarker = "Ephemeral side-channel turn; reuses current conversation context.";
const recapReminder = d(`<system-reminder>${recapMarker}</system-reminder>`);
const recapPrompt = u("<recap>Summarize the current conversation for the user.</recap>");
const earlierAnswer = { role: "assistant", content: [{ type: "text", text: "abridged answer" }], stopReason: "stop", timestamp: 1 };

test("idle recap imports private history without rewriting the main session or cursor", async () => {
	const parent = parentSession();
	parent.shared.cursor = 3;
	T.setSharedSession({ ...parent.shared });
	const sideOptions = { cwd: root, sessionId: `${parent.shared.sessionId}:side:1234`, promptCacheKey: parent.shared.sessionId };
	let imported: ImportedSession | null = null;
	const prompts: PromptMessage[] = [];
	runs.push(async function* ({ prompt, options }) {
		imported = importedSession(options.resume);
		if (typeof prompt !== "string") prompts.push((await prompt[Symbol.asyncIterator]().next()).value);
		yield { type: "result", subtype: "success", result: "recap complete" };
	});
	const side = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("abridged history, not the parent's transcript"), earlierAnswer, recapReminder, recapPrompt,
	]), sideOptions));
	await side.ended.promise;
	await queries[0]!.closed.promise;
	expect(side.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	expect(queryCalls[0]?.options.resume).not.toBe(parent.shared.sessionId);
	expect(queryCalls[0]?.options.persistSession).toBe(false);
	expect(JSON.stringify(requireImported(imported).content)).toContain("abridged history, not the parent's transcript");
	expect(JSON.stringify(requireImported(imported).content)).not.toContain("parent history marker");
	expect(prompts.map(promptText)).toEqual([`${DEVELOPER_OPEN}<system-reminder>${recapMarker}</system-reminder>${DEVELOPER_CLOSE}\n<recap>Summarize the current conversation for the user.</recap>`]);
	expectRemoved(queryCalls[0]?.options.resume);
	expectParentUnchanged(parent);
});

test("a main turn starting while an idle recap is pending keeps its session and prewarm", async () => {
	const parent = parentSession();
	let warmUses = 0;
	let warmCloses = 0;
	const warmPrompts: PromptMessage[] = [];
	startWarm = async (options) => ({
		query(prompt) {
			warmUses++;
			const query = new FakeQuery({ prompt, options }, successRun(warmPrompts, parent.shared.sessionId));
			queries.push(query);
			return query;
		},
		close() { warmCloses++; },
	});
	runs.push(successRun([], parent.shared.sessionId));
	const first = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("parent history marker"), { role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
		u("first main turn"),
	]), { cwd: root }));
	await first.ended.promise;
	await queries[0]!.closed.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	Object.assign(parent.shared, T.getSharedSession()!);
	parent.bytes = readFileSync(parent.path, "utf8");

	const sideStarted = new Deferred<undefined>();
	runs.push(async function* ({ options }, query) {
		importedSession(options.resume);
		sideStarted.resolve(undefined);
		await query.closed.promise;
	});
	const side = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("abridged side history"), earlierAnswer, recapReminder, recapPrompt,
	]), { cwd: root, sessionId: `${parent.shared.sessionId}:side:1234`, promptCacheKey: parent.shared.sessionId }));
	try {
		await sideStarted.promise;
		expectParentUnchanged(parent);
		const main = terminalEvent(T.streamClaudeAgentSdk(model, context([
			u("parent history marker"), { role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
			u("first main turn"), { role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop", timestamp: 1 },
			u("second main turn"),
		]), { cwd: root }));
		await main.ended.promise;
		expect(main.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(warmUses).toBe(1);
		expect(warmCloses).toBe(0);
		expect(warmPrompts.map(promptText)).toEqual(["second main turn"]);
		expect(queryCalls[1]?.options.resume).not.toBe(parent.shared.sessionId);
		expect(readFileSync(parent.path, "utf8")).toBe(parent.bytes);
	} finally {
		queries[1]?.close();
		await side.ended.promise;
	}
	expectRemoved(queryCalls[1]?.options.resume);
});

for (const failure of ["iterator error", "abort"] as const) {
	test(`idle recap ${failure} cleans its private session without invalidating its parent's prewarm`, async () => {
		const parent = parentSession();
		let warmUses = 0;
		let warmCloses = 0;
		startWarm = async (options) => ({
			query(prompt) {
				warmUses++;
				const query = new FakeQuery({ prompt, options }, successRun([], parent.shared.sessionId));
				queries.push(query);
				return query;
			},
			close() { warmCloses++; },
		});
		runs.push(successRun([], parent.shared.sessionId));
		const first = terminalEvent(T.streamClaudeAgentSdk(model, context([
			u("parent history marker"), { role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
			u("main first turn"),
		]), { cwd: root }));
		await first.ended.promise;
		await queries[0]!.closed.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		Object.assign(parent.shared, T.getSharedSession()!);
		parent.bytes = readFileSync(parent.path, "utf8");
		const started = new Deferred<undefined>();
		let imported: ImportedSession | null = null;
		runs.push(async function* ({ options }, query) {
			imported = importedSession(options.resume);
			started.resolve(undefined);
			if (failure === "abort") await query.closed.promise;
			else throw new Error("recap query failed");
		});
		const controller = new AbortController();
		const side = terminalEvent(T.streamClaudeAgentSdk(model, context([
			u("shortened side history"), earlierAnswer, recapReminder, recapPrompt,
		]), { cwd: root, sessionId: `${parent.shared.sessionId}:side:1234`, promptCacheKey: parent.shared.sessionId, signal: controller.signal }));
		await started.promise;
		expect(queryCalls[1]?.options.persistSession).toBe(false);
		expect(queryCalls[1]?.options.resume).not.toBe(parent.shared.sessionId);
		expect(JSON.stringify(requireImported(imported).content)).toContain("shortened side history");
		expectParentUnchanged(parent);
		if (failure === "abort") controller.abort();
		await side.ended.promise;
		await queries[1]!.closed.promise;
		expect(side.events.at(-1)).toMatchObject({ type: "error", error: { stopReason: failure === "abort" ? "aborted" : "error" } });
		expectRemoved(queryCalls[1]?.options.resume);
		expectParentUnchanged(parent);
		expect(warmCloses).toBe(0);
		const next = terminalEvent(T.streamClaudeAgentSdk(model, context([
			u("parent history marker"), { role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
			u("main first turn"), { role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop", timestamp: 1 },
			u("main turn after failed recap"),
		]), { cwd: root }));
		await next.ended.promise;
		expect(next.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(warmUses).toBe(1);
		expect(warmCloses).toBe(0);
		expect(queryCalls).toHaveLength(2);
	});
}

test("recap-looking text in a normal turn still rebuilds drifted main history", async () => {
	const parent = parentSession();
	parent.shared.cursor = 3;
	T.setSharedSession({ ...parent.shared });
	runs.push(successRun([], parent.shared.sessionId));
	const stream = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("revised main history"), earlierAnswer, recapReminder, u("normal user turn quoting <recap>"),
	]), { cwd: root }));
	await stream.ended.promise;
	expect(stream.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	expect(queryCalls[0]?.options.resume).toBe(parent.shared.sessionId);
	expect(queryCalls[0]?.options.persistSession).not.toBe(false);
	const rewritten = readFileSync(parent.path, "utf8");
	expect(rewritten).toContain("revised main history");
	expect(rewritten).not.toContain("parent history marker");
	expect(rewritten).not.toBe(parent.bytes);
});

test("side recap carrying an active parent's tool result never delivers it to that parent", async () => {
	const parent = parentSession();
	const state = {
		prompts: [] as PromptMessage[], results: [] as ToolResult[],
		ready: new Deferred<undefined>(), delivered: new Deferred<undefined>(), finish: new Deferred<undefined>(),
	};
	runs.push(toolRun(["tool-1"], state));
	const parentHistory = [
		u("parent history marker"), { role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
		u("parent active"),
	];
	T.streamClaudeAgentSdk(model, context(parentHistory, [tool]), { cwd: root });
	await state.ready.promise;
	const prompts: PromptMessage[] = [];
	runs.push(successRun(prompts));
	const side = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("abridged tool history"), a("tool-1"), result("tool-1", "side-only copied result"),
		recapReminder, recapPrompt,
	], [tool]), { cwd: root, sessionId: `${parent.shared.sessionId}:side:1234`, promptCacheKey: parent.shared.sessionId }));
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(queryCalls).toHaveLength(2);
		expect(state.results).toEqual([]);
		await side.ended.promise;
		expect(prompts.map(promptText)[0]).toContain("<recap>");
		expect(queryCalls[1]?.options.persistSession).toBe(false);
		expectParentUnchanged(parent);
		const callback = terminalEvent(T.streamClaudeAgentSdk(model, context([
			...parentHistory, a("tool-1"), d("actual parent steer"), result("tool-1", "actual parent result"),
		], [tool]), { cwd: root }));
		await state.delivered.promise;
		expect(state.results.map((entry) => entry.content[0]?.text)).toEqual(["actual parent result"]);
		expect(promptText(state.prompts[1]!)).toContain(`${DEVELOPER_OPEN}actual parent steer${DEVELOPER_CLOSE}`);
		state.finish.resolve(undefined);
		await callback.ended.promise;
	} finally {
		state.finish.resolve(undefined);
		queries[0]?.close();
	}
	expectRemoved(queryCalls[1]?.options.resume);
});

type SessionManagerStub = { id: string; file: string; getSessionId(): string; getSessionFile(): string };
function manager(id: string): SessionManagerStub {
	return {
		id, file: join(root, `${id}.jsonl`),
		getSessionId() { return this.id; },
		getSessionFile() { return this.file; },
	};
}
function extension(manager: SessionManagerStub, activate = activateExtension) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const providers: Array<{ streamSimple: typeof T.streamClaudeAgentSdk }> = [];
	activate({
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, handler); },
		registerProvider(_id: string, provider: { streamSimple: typeof T.streamClaudeAgentSdk }) { providers.push(provider); },
		registerTool() {},
	} as unknown as Parameters<typeof activateExtension>[0]);
	return {
		providers,
		fire(name: string, event: Record<string, unknown> = {}) {
			const handler = handlers.get(name);
			if (!handler) throw new Error(`missing lifecycle handler: ${name}`);
			return handler(event, { sessionManager: manager, ui: { notify() {} } });
		},
	};
}

test("a different manager's lifecycle leaves the owner's transcript and prewarm available", async () => {
	const mainManager = manager("main-session");
	const main = extension(mainManager);
	main.fire("session_start");
	const parent = parentSession();
	let warmUses = 0;
	let warmCloses = 0;
	startWarm = async (options) => ({
		query(prompt) {
			warmUses++;
			const query = new FakeQuery({ prompt, options }, successRun([], parent.shared.sessionId));
			queries.push(query);
			return query;
		},
		close() { warmCloses++; },
	});
	runs.push(successRun([], parent.shared.sessionId));
	const first = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("parent history marker"), { role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
		u("main first turn"),
	]), { cwd: root }));
	await first.ended.promise;
	await queries[0]!.closed.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	Object.assign(parent.shared, T.getSharedSession()!);
	parent.bytes = readFileSync(parent.path, "utf8");

	const child = extension(manager("different-child-session"));
	child.fire("session_start");
	child.fire("session_switch", { reason: "new" });
	child.fire("session_branch");
	child.fire("session_compact", { fromExtension: false });
	child.fire("session_tree");
	expectParentUnchanged(parent);
	expect(warmCloses).toBe(0);
	child.fire("session_shutdown");
	expect(child.providers.at(-1)?.streamSimple).toBe(main.providers.at(-1)?.streamSimple);
	expectParentUnchanged(parent);
	const next = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("parent history marker"), { role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
		u("main first turn"), { role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop", timestamp: 1 },
		u("main next turn"),
	]), { cwd: root }));
	await next.ended.promise;
	expect(warmUses).toBe(1);
	expect(warmCloses).toBe(0);
	expect(queryCalls).toHaveLength(1);
	expect(next.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
});

test("the owning manager's compact and tree events invalidate its warm resume and rebuild history", async () => {
	const owner = extension(manager("compact-owner"));
	owner.fire("session_start");
	const parent = parentSession();
	let warmCloses = 0;
	startWarm = async () => ({ query() { throw new Error("invalidated prewarm was reused"); }, close() { warmCloses++; } });
	runs.push(successRun([], parent.shared.sessionId));
	const initial = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("parent history marker"), { role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
		u("first turn"),
	]), { cwd: root }));
	await initial.ended.promise;
	await queries[0]!.closed.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	owner.fire("session_compact", { fromExtension: false });
	expect(T.getSharedSession()).toMatchObject({ sessionId: parent.shared.sessionId, needsRebuild: true });
	expect(warmCloses).toBe(1);
	owner.fire("session_tree");
	runs.push(successRun([], parent.shared.sessionId));
	const rebuilt = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("revised owner history"), earlierAnswer, u("after compact and tree"),
	]), { cwd: root }));
	await rebuilt.ended.promise;
	expect(queryCalls[1]?.options.resume).toBe(parent.shared.sessionId);
	expect(readFileSync(parent.path, "utf8")).toContain("revised owner history");
	expect(readFileSync(parent.path, "utf8")).not.toContain("parent history marker");
});

test("owner compaction retires a live SDK query and resumes only the compacted tool-result snapshot", async () => {
	const owner = extension(manager("live-compact-owner"));
	owner.fire("session_start");
	const session = createSession({ projectPath: root, claudeDir: root });
	const history: HostMessage[] = [];
	for (let i = 0; i < 12; i++) {
		session.addUserMessage(`discarded history ${i}`);
		session.addAssistantMessage([{ type: "text", text: `old answer ${i}` }]);
		history.push(u(`discarded history ${i}`), {
			role: "assistant", content: [{ type: "text", text: `old answer ${i}` }], stopReason: "stop", timestamp: 1,
		});
	}
	session.save();
	const oldId = session.sessionId;
	T.setSharedSession({ sessionId: oldId, cursor: history.length, cwd: root });
	let warmStarts = 0;
	startWarm = async () => {
		warmStarts++;
		return { query() { throw new Error("unexpected warm query"); }, close() {} };
	};
	const oldReady = new Deferred<undefined>();
	let oldHandler: ToolHandler | undefined;
	let oldResult: Promise<ToolResult> | undefined;
	const oldFinished = new Deferred<undefined>();
	runs.push(async function* ({ prompt, options }, query) {
		try {
			if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
			yield { type: "system", subtype: "init", session_id: oldId };
			yield { type: "assistant", message: { content: [{ type: "tool_use", id: "old-tool", name: "mcp__custom-tools__echo", input: {} }] } };
			oldHandler = options.mcpServers?.["custom-tools"]?.instance.tools[0]?.handler;
			if (!oldHandler) throw new Error("missing old tool handler");
			oldResult = oldHandler("old-tool");
			oldReady.resolve(undefined);
			await query.closed.promise;
			yield { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 9000, output_tokens: 90 } } } };
			yield { type: "result", subtype: "success", result: "stale SDK answer" };
		} finally {
			oldFinished.resolve(undefined);
		}
	});
	const first = terminalEvent(T.streamClaudeAgentSdk(model, context([...history, u("original work")], [tool]), { cwd: root }));
	await oldReady.promise;
	await first.ended.promise;
	owner.fire("session_compact", { fromExtension: false });

	const freshReady = new Deferred<undefined>();
	const nextTool = new Deferred<ToolResult>();
	const freshPrompt: PromptMessage[] = [];
	let imported: ImportedSession | null = null;
	runs.push(async function* ({ prompt, options }, query) {
		imported = importedSession(options.resume);
		if (typeof prompt !== "string") freshPrompt.push((await prompt[Symbol.asyncIterator]().next()).value);
		yield { type: "system", subtype: "init", session_id: options.resume };
		yield { type: "assistant", message: { content: [{ type: "tool_use", id: "new-tool", name: "mcp__custom-tools__echo", input: {} }], usage: { input_tokens: 7, output_tokens: 3 } } };
		const handler = options.mcpServers?.["custom-tools"]?.instance.tools[0]?.handler;
		if (!handler) throw new Error("missing new tool handler");
		void handler("new-tool").then((value) => nextTool.resolve(value));
		freshReady.resolve(undefined);
		const delivered = await Promise.race([nextTool.promise, query.closed.promise]);
		if (!delivered) return;
		if (delivered.content[0]?.text !== "next tool answer") throw new Error("incorrect next-round tool result");
		yield { type: "assistant", message: { content: [{ type: "text", text: "continued original work" }], usage: { input_tokens: 7, output_tokens: 3 } } };
		yield { type: "result", subtype: "success", result: "continued original work" };
	});
	const compacted = context([
		u("compact summary: continue the original work"), a("old-tool"), result("old-tool", "exact imported result"),
		d("pending developer instruction"), u("pending user instruction"),
	], [tool]);
	const resumed = terminalEvent(T.streamClaudeAgentSdk(model, compacted, { cwd: root }));
	expect(queryCalls).toHaveLength(2);
	await freshReady.promise;
	await resumed.ended.promise;
	const newId = queryCalls[1]?.options.resume;
	expect(newId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
	expect(newId).not.toBe(oldId);
	const snapshot = JSON.stringify(requireImported(imported).content);
	expect(snapshot).toContain("compact summary: continue the original work");
	expect(snapshot).toContain("exact imported result");
	expect(snapshot).not.toContain("discarded history");
	expect(snapshot).not.toContain("pending developer instruction");
	const prompt = freshPrompt.map(promptText).join("\n");
	expect(prompt).toContain(`${DEVELOPER_OPEN}pending developer instruction${DEVELOPER_CLOSE}`);
	expect(prompt).toContain("pending user instruction");
	expect(prompt).not.toContain("[continue]");
	expect(resumed.events.at(-1)).toMatchObject({ type: "done", reason: "toolUse", message: { usage: { input: 7, output: 3 } } });
	expect(resumed.events.some((event) => JSON.stringify(event).includes("new-tool"))).toBe(true);
	const replay = terminalEvent(T.streamClaudeAgentSdk(model, compacted, { cwd: root }));
	await replay.ended.promise;
	expect(queryCalls).toHaveLength(2);
	expect(T.getMainQueryContext().activeQuery).toBe(queries[1]);
	const retired = await oldResult;
	expect(retired?.isError).toBe(true);
	expect(JSON.stringify(retired)).not.toContain("exact imported result");
	await oldFinished.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(warmStarts).toBe(0);
	expect(T.getSharedSession()?.sessionId).toBe(newId);
	expect(T.getSharedSession()?.cursor).toBeLessThanOrEqual(compacted.messages.length);
	expect(resumed.events.some((event) => JSON.stringify(event).includes("stale SDK answer"))).toBe(false);
	const beforeLateWrite = readFileSync(requireImported(imported).path, "utf8");
	writeFileSync(session.jsonlPath, "\nlate SDK append on retired path", { flag: "a" });
	expect(readFileSync(requireImported(imported).path, "utf8")).toBe(beforeLateWrite);

	const secondRound = context([
		...compacted.messages, a("new-tool"), result("new-tool", "next tool answer"),
	], [tool]);
	const final = terminalEvent(T.streamClaudeAgentSdk(model, secondRound, { cwd: root }));
	await final.ended.promise;
	expect(final.events.some((event) => JSON.stringify(event).includes("continued original work"))).toBe(true);
	expect(final.events.at(-1)).toMatchObject({ type: "done", message: { usage: { input: 7, output: 3 } } });
	await expect(nextTool.promise).resolves.toMatchObject({ content: [{ text: "next tool answer" }] });
	expect(T.getSharedSession()).toMatchObject({ sessionId: newId });
	const lateHandler = await oldHandler!("old-tool");
	expect(lateHandler.isError).toBe(true);
	expect(JSON.stringify(lateHandler)).not.toContain("next tool answer");
	const duplicate = terminalEvent(T.streamClaudeAgentSdk(model, secondRound, { cwd: root }));
	await duplicate.ended.promise;
	expect(queryCalls).toHaveLength(2);
	expect(T.getSharedSession()).toMatchObject({ sessionId: newId });
});

test("first live SDK query without a published session rotates after owner compaction, not child lifecycle", async () => {
	const owner = extension(manager("first-query-owner"));
	owner.fire("session_start");
	const oldId = "22222222-2222-4222-8222-222222222222";
	const started = new Deferred<undefined>();
	let pending: Promise<ToolResult> | undefined;
	runs.push(async function* ({ prompt, options }, query) {
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		yield { type: "system", subtype: "init", session_id: oldId };
		yield { type: "assistant", message: { content: [{ type: "tool_use", id: "first-tool", name: "mcp__custom-tools__echo", input: {} }] } };
		const handler = options.mcpServers?.["custom-tools"]?.instance.tools[0]?.handler;
		if (!handler) throw new Error("missing first-query handler");
		pending = handler("first-tool");
		started.resolve(undefined);
		await query.closed.promise;
		yield { type: "result", subtype: "success", result: "obsolete first-query answer" };
	});
	const first = terminalEvent(T.streamClaudeAgentSdk(model, context([u("original first-query job")], [tool]), { cwd: root }));
	await started.promise;
	await first.ended.promise;
	expect(queryCalls[0]?.options.resume).toBeUndefined();
	expect(T.getSharedSession()).toBeNull();
	const child = extension(manager("other-manager"));
	child.fire("session_start");
	child.fire("session_compact", { fromExtension: false });
	child.fire("session_shutdown");
	expect(T.getMainQueryContext().activeQuery).toBe(queries[0]);
	expect(queryCalls).toHaveLength(1);
	owner.fire("session_compact", { fromExtension: false });

	const prompts: PromptMessage[] = [];
	let imported: ImportedSession | null = null;
	runs.push(async function* ({ prompt, options }) {
		imported = importedSession(options.resume);
		if (typeof prompt !== "string") prompts.push((await prompt[Symbol.asyncIterator]().next()).value);
		yield { type: "system", subtype: "init", session_id: options.resume };
		yield { type: "result", subtype: "success", result: "first-query work continued" };
	});
	const resumed = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("summary retaining the original first-query job"), a("first-tool"),
		result("first-tool", "first imported result"), d("fresh instruction"),
	], [tool]), { cwd: root }));
	expect(queryCalls).toHaveLength(2);
	await resumed.ended.promise;
	expect(queryCalls[1]?.options.resume).not.toBe(oldId);
	expect(JSON.stringify(requireImported(imported).content)).toContain("first imported result");
	expect(promptText(prompts[0]!)).toContain(`${DEVELOPER_OPEN}fresh instruction${DEVELOPER_CLOSE}`);
	expect(promptText(prompts[0]!)).not.toContain("[continue]");
	expect(resumed.events.some((event) => JSON.stringify(event).includes("first-query work continued"))).toBe(true);
	expect(resumed.events.some((event) => JSON.stringify(event).includes("obsolete first-query answer"))).toBe(false);
	expect((await pending)?.isError).toBe(true);
	expect(T.getSharedSession()?.sessionId).toBe(queryCalls[1]?.options.resume);
});
test("owner compact event overrides equal-length history and the first tool callback cursor", async () => {
	const owner = extension(manager("equal-length-compact-owner"));
	owner.fire("session_start");
	const session = createSession({ projectPath: root, claudeDir: root });
	session.addUserMessage("obsolete turn");
	session.addAssistantMessage([{ type: "text", text: "obsolete answer" }]);
	session.save();
	T.setSharedSession({ sessionId: session.sessionId, cursor: 2, cwd: root });
	const started = new Deferred<undefined>();
	let pending: Promise<ToolResult> | undefined;
	runs.push(async function* ({ prompt, options }, query) {
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		yield { type: "system", subtype: "init", session_id: session.sessionId };
		yield { type: "assistant", message: { content: [{ type: "tool_use", id: "same-count", name: "mcp__custom-tools__echo", input: {} }] } };
		const handler = options.mcpServers?.["custom-tools"]?.instance.tools[0]?.handler;
		if (!handler) throw new Error("missing equal-length handler");
		pending = handler("same-count");
		started.resolve(undefined);
		await query.closed.promise;
	});
	const original = context([u("obsolete turn"), earlierAnswer, u("original task"), d("original instruction")], [tool]);
	const first = terminalEvent(T.streamClaudeAgentSdk(model, original, { cwd: root }));
	await started.promise;
	await first.ended.promise;
	owner.fire("session_compact", { fromExtension: false });
	const prompts: PromptMessage[] = [];
	let imported: ImportedSession | null = null;
	runs.push(async function* ({ prompt, options }) {
		imported = importedSession(options.resume);
		if (typeof prompt !== "string") prompts.push((await prompt[Symbol.asyncIterator]().next()).value);
		yield { type: "system", subtype: "init", session_id: options.resume };
		yield { type: "result", subtype: "success", result: "same-count work resumed" };
	});
	const compacted = context([
		u("new summary of original task"), a("same-count"), result("same-count", "exact result"),
		d("new instruction"),
	], [tool]);
	expect(compacted.messages).toHaveLength(original.messages.length);
	const resumed = terminalEvent(T.streamClaudeAgentSdk(model, compacted, { cwd: root }));
	expect(queryCalls).toHaveLength(2);
	await resumed.ended.promise;
	expect(queryCalls[1]?.options.resume).not.toBe(session.sessionId);
	expect(JSON.stringify(requireImported(imported).content)).toContain("exact result");
	expect(JSON.stringify(requireImported(imported).content)).not.toContain("obsolete turn");
	expect(promptText(prompts[0]!)).toContain("new instruction");
	expect(promptText(prompts[0]!)).not.toContain("original instruction");
	expect((await pending)?.isError).toBe(true);
	expect(resumed.events.at(-1)).toMatchObject({ type: "done", message: { content: [{ text: "same-count work resumed" }] } });
});


test("owner compaction resumes tool-only callback with an explicit continuation prompt", async () => {
	const owner = extension(manager("tool-only-compact-owner"));
	owner.fire("session_start");
	const oldReady = new Deferred<undefined>();
	const oldId = "55555555-5555-4555-8555-555555555555";
	let oldResult: Promise<ToolResult> | undefined;
	runs.push(async function* ({ prompt, options }, query) {
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		yield { type: "system", subtype: "init", session_id: oldId };
		yield { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-only", name: "mcp__custom-tools__echo", input: {} }] } };
		const handler = options.mcpServers?.["custom-tools"]?.instance.tools[0]?.handler;
		if (!handler) throw new Error("missing old tool handler");
		oldResult = handler("tool-only");
		oldReady.resolve(undefined);
		await query.closed.promise;
		throw new Error("stale old SDK failure");
	});
	const first = terminalEvent(T.streamClaudeAgentSdk(model, context([u("solve the original task")], [tool]), { cwd: root }));
	await oldReady.promise;
	await first.ended.promise;
	owner.fire("session_compact", { fromExtension: false });
	const prompts: PromptMessage[] = [];
	let imported: ImportedSession | null = null;
	runs.push(async function* ({ prompt, options }) {
		imported = importedSession(options.resume);
		if (typeof prompt !== "string") prompts.push((await prompt[Symbol.asyncIterator]().next()).value);
		yield { type: "system", subtype: "init", session_id: options.resume };
		yield { type: "assistant", message: { content: [{ type: "text", text: "solved original task" }], usage: { input_tokens: 4, output_tokens: 2 } } };
		yield { type: "result", subtype: "success", result: "solved original task" };
	});
	const compacted = context([
		u("summary: solve the original task"), a("tool-only"), result("tool-only", "exact tool-only output"),
	], [tool]);
	const resumed = terminalEvent(T.streamClaudeAgentSdk(model, compacted, { cwd: root }));
	expect(queryCalls).toHaveLength(2);
	await resumed.ended.promise;
	expect(queryCalls[1]?.options.resume).not.toBe(oldId);
	const snapshot = JSON.stringify(requireImported(imported).content);
	expect(snapshot).toContain("summary: solve the original task");
	expect(snapshot).toContain("exact tool-only output");
	expect(prompts).toHaveLength(1);
	expect(promptText(prompts[0]!)).toMatch(/\bcontinu\w*\b/i);
	expect(promptText(prompts[0]!)).not.toContain("[continue]");
	expect(promptText(prompts[0]!)).not.toContain("exact tool-only output");
	expect(resumed.events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "solved original task" }));
	expect(resumed.events.at(-1)).toMatchObject({ type: "done", reason: "stop", message: { usage: { input: 4, output: 2 } } });
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(resumed.events.some((event) => JSON.stringify(event).includes("stale old SDK failure"))).toBe(false);
	expect(T.getSharedSession()?.sessionId).toBe(queryCalls[1]?.options.resume);
	expect((await oldResult)?.isError).toBe(true);
});

test("aborted compacted tool callback never starts a replacement SDK query", async () => {
	const owner = extension(manager("aborted-compact-owner"));
	owner.fire("session_start");
	const started = new Deferred<undefined>();
	runs.push(async function* ({ prompt }, query) {
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		yield { type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" };
		yield { type: "assistant", message: { content: [{ type: "tool_use", id: "abort-tool", name: "mcp__custom-tools__echo", input: {} }] } };
		started.resolve(undefined);
		await query.closed.promise;
	});
	const first = terminalEvent(T.streamClaudeAgentSdk(model, context([u("work")], [tool]), { cwd: root }));
	await started.promise;
	await first.ended.promise;
	owner.fire("session_compact", { fromExtension: false });
	const abort = new AbortController();
	abort.abort();
	const callback = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("summary"), a("abort-tool"), result("abort-tool", "aborted result"), d("pending instruction"),
	], [tool]), { cwd: root, signal: abort.signal }));
	let callbackEnded = false;
	void callback.ended.promise.then(() => { callbackEnded = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	try {
		expect(queryCalls).toHaveLength(1);
		expect(callbackEnded).toBe(true);
		expect(callback.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	} finally {
		queries[0]!.close();
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
	const prompts: PromptMessage[] = [];
	runs.push(successRun(prompts, "66666666-6666-4666-8666-666666666666"));
	const next = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("compact summary of previous task"), a("abort-tool"), result("abort-tool", "aborted result"),
		u("new real user request"),
	], [tool]), { cwd: root }));
	expect(queryCalls).toHaveLength(2);
	let nextEnded = false;
	void next.ended.promise.then(() => { nextEnded = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(nextEnded).toBe(true);
	expect(promptText(prompts[0]!)).toContain("new real user request");
	expect(next.events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "finished" }));
	expect(next.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
});

for (const compactFirst of [true, false]) {
	test(`compaction and abort (${compactFirst ? "compact before abort" : "abort before compact"}) do not steer the next independent user turn`, async () => {
		const owner = extension(manager("abort-after-compact-owner"));
		owner.fire("session_start");
		const parent = parentSession();
		const abort = new AbortController();
		const started = new Deferred<undefined>();
		runs.push(async function* ({ prompt, options }, query) {
			if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
			yield { type: "system", subtype: "init", session_id: parent.shared.sessionId };
			yield { type: "assistant", message: { content: [{ type: "tool_use", id: "aborted-after-compact", name: "mcp__custom-tools__echo", input: {} }] } };
			const handler = options.mcpServers?.["custom-tools"]?.instance.tools[0]?.handler;
			if (!handler) throw new Error("missing abort tool handler");
			void handler("aborted-after-compact");
			started.resolve(undefined);
			await query.closed.promise;
			yield { type: "result", subtype: "success", result: "outdated aborted answer" };
		});
		const old = terminalEvent(T.streamClaudeAgentSdk(model, context([
			u("parent history marker"),
			{ role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
			u("aborted original task"),
		], [tool]), { cwd: root, signal: abort.signal }));
		await started.promise;
		await old.ended.promise;
		if (compactFirst) {
			owner.fire("session_compact", { fromExtension: false });
			abort.abort();
		} else {
			abort.abort();
			owner.fire("session_compact", { fromExtension: false });
		}
		await queries[0]!.closed.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(T.getMainQueryContext().activeQuery).toBeNull();
		const prompts: PromptMessage[] = [];
		runs.push(successRun(prompts, "99999999-9999-4999-8999-999999999999"));
		const fresh = terminalEvent(T.streamClaudeAgentSdk(model, context([
			u("compacted summary of aborted task"), a("aborted-after-compact"),
			result("aborted-after-compact", "orphaned old result"), u("independent new user request"),
		], [tool]), { cwd: root }));
		expect(queryCalls).toHaveLength(2);
		let finished = false;
		void fresh.ended.promise.then(() => { finished = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(finished).toBe(true);
		expect(prompts.map(promptText)).toEqual(["independent new user request"]);
		expect(fresh.events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "finished" }));
		expect(fresh.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	});
}

test("first-query compact survives its finalizer and does not retire the next query's tool callback", async () => {
	const owner = extension(manager("finished-first-compact-owner"));
	owner.fire("session_start");
	const originalId = "77777777-7777-4777-8777-777777777777";
	const started = new Deferred<undefined>();
	const finish = new Deferred<undefined>();
	let warmStarts = 0;
	startWarm = async () => {
		warmStarts++;
		return { query() { throw new Error("unexpected prewarm"); }, close() {} };
	};
	runs.push(async function* ({ prompt }) {
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		yield { type: "system", subtype: "init", session_id: originalId };
		started.resolve(undefined);
		await finish.promise;
		yield { type: "result", subtype: "success", result: "old precompact answer" };
	});
	const first = terminalEvent(T.streamClaudeAgentSdk(model, context([u("obsolete first-query task")], [tool]), { cwd: root }));
	await started.promise;
	expect(T.getSharedSession()).toBeNull();
	owner.fire("session_compact", { fromExtension: false });
	finish.resolve(undefined);
	await first.ended.promise;
	await queries[0]!.closed.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(T.getSharedSession()).toMatchObject({ sessionId: originalId, needsRebuild: true });
	expect(warmStarts).toBe(0);

	let imported: ImportedSession | null = null;
	const secondReady = new Deferred<undefined>();
	runs.push(async function* ({ prompt, options }, query) {
		imported = importedSession(options.resume);
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		yield { type: "system", subtype: "init", session_id: options.resume };
		yield { type: "assistant", message: { content: [{ type: "tool_use", id: "fresh-tool", name: "mcp__custom-tools__echo", input: {} }] } };
		const handler = options.mcpServers?.["custom-tools"]?.instance.tools[0]?.handler;
		if (!handler) throw new Error("missing fresh tool handler");
		const answer = handler("fresh-tool");
		secondReady.resolve(undefined);
		const delivered = await Promise.race([answer, query.closed.promise]);
		if (!delivered) return;
		if (delivered.content[0]?.text !== "fresh tool answer") throw new Error("wrong fresh tool result");
		yield { type: "result", subtype: "success", result: "fresh task completed" };
	});
	const current = context([u("new compact summary"), earlierAnswer, u("next main task")], [tool]);
	const second = terminalEvent(T.streamClaudeAgentSdk(model, current, { cwd: root }));
	await secondReady.promise;
	await second.ended.promise;
	const snapshot = JSON.stringify(requireImported(imported).content);
	expect(snapshot).toContain("new compact summary");
	expect(snapshot).not.toContain("obsolete first-query task");
	const callback = terminalEvent(T.streamClaudeAgentSdk(model, context([
		...current.messages, a("fresh-tool"), result("fresh-tool", "fresh tool answer"),
	], [tool]), { cwd: root }));
	expect(queryCalls).toHaveLength(2);
	let callbackEnded = false;
	void callback.ended.promise.then(() => { callbackEnded = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(callbackEnded).toBe(true);
	expect(callback.events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "fresh task completed" }));
	expect(callback.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	expect(queryCalls).toHaveLength(2);
});

test("prior query finalizer cannot unregister the next live query's compact retirement", async () => {
	const owner = extension(manager("overlapping-compact-owner"));
	owner.fire("session_start");
	const parent = parentSession();
	const history = [
		u("parent history marker"),
		{ role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
	];
	runs.push(successRun([], parent.shared.sessionId));
	const first = terminalEvent(T.streamClaudeAgentSdk(model, context([...history, u("first main request")], [tool]), { cwd: root }));
	await first.ended.promise;
	// The first stream ends in its .then(); its .finally() has not yet had a
	// chance to run. Register the next main query before crossing that boundary.
	const secondReady = new Deferred<undefined>();
	let parked: Promise<ToolResult> | undefined;
	runs.push(async function* ({ prompt, options }, query) {
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		yield { type: "system", subtype: "init", session_id: parent.shared.sessionId };
		yield { type: "assistant", message: { content: [{ type: "tool_use", id: "overlap-tool", name: "mcp__custom-tools__echo", input: {} }] } };
		const handler = options.mcpServers?.["custom-tools"]?.instance.tools[0]?.handler;
		if (!handler) throw new Error("missing overlapping tool handler");
		parked = handler("overlap-tool");
		secondReady.resolve(undefined);
		await query.closed.promise;
	});
	const second = terminalEvent(T.streamClaudeAgentSdk(model, context([
		...history, u("first main request"),
		{ role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop", timestamp: 1 },
		u("second main request"),
	], [tool]), { cwd: root }));
	await secondReady.promise;
	await second.ended.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	owner.fire("session_compact", { fromExtension: false });
	const prompts: PromptMessage[] = [];
	runs.push(async function* ({ prompt, options }) {
		if (typeof prompt !== "string") prompts.push((await prompt[Symbol.asyncIterator]().next()).value);
		yield { type: "system", subtype: "init", session_id: options.resume };
		yield { type: "result", subtype: "success", result: "replacement after overlap" };
	});
	const resumed = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("compact summary after two main requests"), a("overlap-tool"),
		result("overlap-tool", "overlap result"), d("pending overlap instruction"),
	], [tool]), { cwd: root }));
	expect(queryCalls).toHaveLength(3);
	await resumed.ended.promise;
	expect(queryCalls[2]?.options.resume).not.toBe(parent.shared.sessionId);
	expect(promptText(prompts[0]!)).toContain("pending overlap instruction");
	expect(resumed.events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "replacement after overlap" }));
	expect((await parked)?.isError).toBe(true);
});

test("a critical handoff steered before compaction is not repeated in the replacement prompt", async () => {
	const owner = extension(manager("handoff-compact-owner"));
	owner.fire("session_start");
	const firstToolReady = new Deferred<undefined>();
	const nextToolReady = new Deferred<undefined>();
	const oldPrompts: PromptMessage[] = [];
	let parked: Promise<ToolResult> | undefined;
	runs.push(async function* ({ prompt, options }, query) {
		if (typeof prompt === "string") throw new Error("expected SDK input stream");
		const input = prompt[Symbol.asyncIterator]();
		oldPrompts.push((await input.next()).value);
		yield { type: "system", subtype: "init", session_id: "44444444-4444-4444-8444-444444444444" };
		yield { type: "assistant", message: { content: [{ type: "tool_use", id: "handoff-tool", name: "mcp__custom-tools__echo", input: {} }] } };
		const handler = options.mcpServers?.["custom-tools"]?.instance.tools[0]?.handler;
		if (!handler) throw new Error("missing old tool handler");
		const firstResult = handler("handoff-tool");
		firstToolReady.resolve(undefined);
		const steer = await Promise.race([
			input.next().catch(() => ({ done: true as const, value: undefined })),
			query.closed.promise.then(() => ({ done: true as const, value: undefined })),
		]);
		if (steer.done) return;
		oldPrompts.push(steer.value);
		void input.next().catch(() => {});
		if ((await firstResult).content[0]?.text !== "handoff tool output") throw new Error("handoff result lost");
		yield { type: "assistant", message: { content: [{ type: "tool_use", id: "late-tool", name: "mcp__custom-tools__echo", input: {} }] } };
		parked = handler("late-tool");
		nextToolReady.resolve(undefined);
		await query.closed.promise;
		yield { type: "result", subtype: "success", result: "obsolete handoff response" };
	});
	const first = terminalEvent(T.streamClaudeAgentSdk(model, context([u("finish original task")], [tool]), { cwd: root }));
	await firstToolReady.promise;
	await first.ended.promise;
	const handoff = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("finish original task"), a("handoff-tool"),
		d("<critical>handoff marker: continue original task</critical>"), result("handoff-tool", "handoff tool output"),
	], [tool]), { cwd: root }));
	await nextToolReady.promise;
	await handoff.ended.promise;
	expect(oldPrompts.map(promptText).join("\n")).toContain("<critical>handoff marker: continue original task</critical>");
	owner.fire("session_compact", { fromExtension: false });
	const newPrompts: PromptMessage[] = [];
	runs.push(async function* ({ prompt, options }) {
		if (typeof prompt !== "string") newPrompts.push((await prompt[Symbol.asyncIterator]().next()).value);
		yield { type: "system", subtype: "init", session_id: options.resume };
		yield { type: "result", subtype: "success", result: "original task completed" };
	});
	const resumed = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("summary: finish original task"), a("late-tool"), result("late-tool", "second imported output"),
		d("new instruction after compact"),
	], [tool]), { cwd: root }));
	expect(queryCalls).toHaveLength(2);
	await resumed.ended.promise;
	const prompt = newPrompts.map(promptText).join("\n");
	expect(prompt).toContain("new instruction after compact");
	expect(prompt).not.toContain("<critical>handoff marker");
	expect(prompt).not.toContain("[continue]");
	expect((await parked)?.isError).toBe(true);
	expect(resumed.events.some((event) => JSON.stringify(event).includes("original task completed"))).toBe(true);
	expect(resumed.events.some((event) => JSON.stringify(event).includes("obsolete handoff response"))).toBe(false);
});

test("owner identity persists across session switches but its new session and branch cannot resume stale history", async () => {
	const ownManager = manager("first-owner-session");
	const owner = extension(ownManager);
	owner.fire("session_start");
	const first = parentSession();
	ownManager.id = "new-owner-session";
	ownManager.file = join(root, "new-owner-session.jsonl");
	owner.fire("session_switch", { reason: "new" });
	expect(T.getSharedSession()).toBeNull();
	T.setSharedSession({ ...first.shared });
	ownManager.id = "switched-owner-session";
	ownManager.file = join(root, "switched-owner-session.jsonl");
	owner.fire("session_switch", { reason: "switch" });
	expect(T.getSharedSession()).toBeNull();
	T.setSharedSession({ ...first.shared });
	owner.fire("session_branch");
	expect(T.getSharedSession()).toBeNull();
	expect(readFileSync(first.path, "utf8")).toBe(first.bytes);
	runs.push(successRun([]));
	const fresh = terminalEvent(T.streamClaudeAgentSdk(model, context([u("new branch input")]), { cwd: root }));
	await fresh.ended.promise;
	expect(queryCalls[0]?.options.resume).toBeUndefined();
});

test("owner shutdown blocks a late query finalizer from restoring its session or spawning prewarm", async () => {
	const owner = extension(manager("shutdown-owner"));
	owner.fire("session_start");
	const parent = parentSession();
	let warmStarts = 0;
	startWarm = async () => {
		warmStarts++;
		return { query() { throw new Error("unexpected prewarm"); }, close() {} };
	};
	const started = new Deferred<undefined>();
	const finish = new Deferred<undefined>();
	runs.push(async function* ({ prompt }) {
		if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
		yield { type: "system", subtype: "init", session_id: parent.shared.sessionId };
		started.resolve(undefined);
		await finish.promise;
		yield { type: "result", subtype: "success", result: "late main answer" };
	});
	const stream = terminalEvent(T.streamClaudeAgentSdk(model, context([
		u("parent history marker"), { role: "assistant", content: [{ type: "text", text: "parent answered earlier" }], stopReason: "stop", timestamp: 1 },
		u("pending main"),
	]), { cwd: root }));
	await started.promise;
	const registrations = owner.providers.length;
	owner.fire("session_shutdown");
	expect(T.getSharedSession()).toBeNull();
	finish.resolve(undefined);
	await stream.ended.promise;
	expect(T.getSharedSession()).toBeNull();
	await queries[0]!.closed.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(owner.providers).toHaveLength(registrations);
	expect(warmStarts).toBe(0);
	expect(readFileSync(parent.path, "utf8")).toBe(parent.bytes);
	runs.push(successRun([]));
	const next = terminalEvent(T.streamClaudeAgentSdk(model, context([u("fresh session after shutdown")]), { cwd: root }));
	await next.ended.promise;
	expect(queryCalls[1]?.options.resume).toBeUndefined();
});

test("late child shutdown cannot take ownership from a replacement extension module", async () => {
	const owner = extension(manager("previous-owner"));
	owner.fire("session_start");
	const child = extension(manager("late-child"));
	child.fire("session_start");
	owner.fire("session_shutdown");
	child.fire("session_shutdown");

	// A distinct evaluation models a newly loaded extension, not another runner
	// calling the same cached module's activation function.
	const { default: activateNext, __test: nextT } = await import("../src/index.ts?replacement-owner");
	try {
		const replacement = extension(manager("replacement-owner"), activateNext);
		replacement.fire("session_start");
		const parent = parentSession();
		nextT.setSharedSession({ ...parent.shared });
		replacement.fire("session_switch", { reason: "new" });
		expect(nextT.getSharedSession()).toBeNull();
		expect(readFileSync(parent.path, "utf8")).toBe(parent.bytes);
	} finally {
		nextT.clearSession();
	}
});

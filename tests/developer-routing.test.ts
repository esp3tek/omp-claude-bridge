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
mock.module("@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim", () => ({ ...hostModule, getModels: () => [] }));
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

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
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
type QueryOptions = { mcpServers?: Record<string, FakeMcpServer>; resume?: string };
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
const sdkModule = { ...originalSdk };
const hostModule = { ...originalHost };
const mcpModule = { ...originalMcp };
const osModule = { ...originalOs };

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	query: (args: QueryArgs) => {
		const run = runs.shift();
		if (!run) throw new Error("unexpected SDK query");
		queryCalls.push(args);
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
process.env.CLAUDE_CONFIG_DIR = root;
process.env.CLAUDE_BRIDGE_DEBUG = "0";
// The pre-fix empty-developer regression emits an unconditional diagnostic.
// Keep every possible fixture artifact inside the repository temporary root.
mock.module("os", () => ({ ...osModule, homedir: () => root }));
// Static import cannot work: the module under test must observe the SDK mocks.
// This query string gives the routing fixture its own index evaluation: other
// test files load the normal extension before this test installs host mocks.
const { __test: T } = await import("../src/index.ts?developer-routing");
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

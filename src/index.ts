import { StringEnum, Type, getModels, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool, type Usage } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import * as piAi from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import { type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { keyHint } from "@oh-my-pi/pi-tui/chrome";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { compact } from "@oh-my-pi/pi-agent-core/compaction";
import { query, startup, type EffortLevel, type Query, type SDKMessage, type SDKUserMessage, type SettingSource, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { Text } from "@oh-my-pi/pi-tui";
import { createSession, deleteSession, repairToolPairing } from "cc-session-io";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { PROVIDER_ID, messageContentToText, convertPiMessages, importMessagesLossless, splitPendingInput } from "./convert.js";
import { buildVariantModels, buildModels, STATIC_FALLBACK_IDS, claudeCodeModelId, type ContextWindowMode, type LongContextSettings, resolveModel as _resolveModel } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, extractSkillsBlock } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, ctx } from "./query-state.js";
import { loadConfig, type Config } from "./config.js";
import { extractAgentsAppend } from "./agents-md.js";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.js";
import { ClaudeUsageLimitError, rateLimitNotice, usageLimitError } from "./rate-limit.js";
import { CC_MCP_DESCRIPTION_LIMIT, TOOL_REFERENCE_HEADER, packToolDescription } from "./tool-description.js";
import { buildUsageReport, recordRateLimitEvent } from "./usage.js";
import { makePromptStream, userMessage, type PromptStream } from "./prompt-stream.js";
import { createToolServer } from "./mcp-server.js";
import { fetchClaudeCodeModels, toProviderModels } from "./claude-models.js";

// Compat (#2): use factory if available (pi-ai ≥0.66), else fall back to constructor (gsd-pi etc.)
const _piAi = piAi as any;
let newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();

function calculateCost(model: Model<any>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
	usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
	return usage.cost;
}

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.omp/agent/claude-bridge.log.
// So does "debug": true in ~/.omp/agent/claude-bridge.json, for hosts launched from
// a terminal that predates the environment variable (CLAUDE_BRIDGE_DEBUG=0 wins).

function debugFromConfigFile(): boolean {
	try {
		const raw = readFileSync(join(homedir(), ".omp", "agent", "claude-bridge.json"), "utf8");
		return (JSON.parse(raw) as { debug?: unknown }).debug === true;
	} catch {
		return false;
	}
}

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1"
	|| (process.env.CLAUDE_BRIDGE_DEBUG !== "0" && debugFromConfigFile());
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".omp", "agent", "claude-bridge.log");
const DIAG_LOG_PATH = join(homedir(), ".omp", "agent", "claude-bridge-diag.log");

// Debug logging is meant to stay on permanently, so keep it bounded:
// per-query CLI logs older than this are pruned at startup, and the main log
// is rotated to .1 once it passes the size cap (CLAUDE_BRIDGE_DEBUG_KEEP_DAYS,
// CLAUDE_BRIDGE_DEBUG_MAX_MB to tune).
const DEBUG_KEEP_DAYS = Number(process.env.CLAUDE_BRIDGE_DEBUG_KEEP_DAYS ?? 7);
const DEBUG_MAX_BYTES = Number(process.env.CLAUDE_BRIDGE_DEBUG_MAX_MB ?? 20) * 1024 * 1024;

function pruneDebugArtifacts(): void {
	const cutoff = Date.now() - DEBUG_KEEP_DAYS * 86_400_000;
	const cliDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
	try {
		let removed = 0;
		for (const name of readdirSync(cliDir)) {
			const p = join(cliDir, name);
			try { if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; } } catch { /* in use or gone */ }
		}
		if (removed) appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] [startup] debug: pruned ${removed} cc-cli-logs older than ${DEBUG_KEEP_DAYS} days\n`);
	} catch { /* no dir yet */ }
	for (const logPath of [DEBUG_LOG_PATH, DIAG_LOG_PATH]) {
		try {
			if (statSync(logPath).size > DEBUG_MAX_BYTES) renameSync(logPath, `${logPath}.1`);
		} catch { /* missing */ }
	}
}

// Ensure log directories exist when debug is enabled
if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
		pruneDebugArtifacts();
	} catch {
		// If directory creation fails, debug functions will throw on first use
	}
}

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
// Environment variables that change where the Claude Code child sends its
// requests, or what pays for them.
const REDIRECTING_ENV = [
	{ name: "ANTHROPIC_BASE_URL", why: "sends Claude Code's requests to that endpoint instead of Anthropic" },
	{ name: "ANTHROPIC_AUTH_TOKEN", why: "authenticates Claude Code with that token instead of your Claude Code session" },
	{ name: "ANTHROPIC_API_KEY", why: "bills Claude Code per token against that key instead of your subscription" },
];
let redirectingEnvWarned = false;

function warnAboutRedirectingEnvOnce(): void {
	if (redirectingEnvWarned) return;
	redirectingEnvWarned = true;
	const set = REDIRECTING_ENV.filter((v) => (process.env[v.name] ?? "").trim() !== "");
	if (!set.length) return;
	const detail = set.map((v) => `${v.name} ${v.why}`).join("; ");
	debug(`env: ${detail}`);
	piUI?.notify(`Claude bridge: ${detail}. Unset it if you meant to run on your Claude Code subscription.`, "warning");
}

function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
	debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

// --- Constants ---

// Global key to prevent re-registration of the provider across module reloads.
//
// Extensions like OMP subagents spawn a subagent and it loads this module
// again. Without this guard, the subagent's call to registerProvider() would
// overwrite the parent's `streamSimple` function reference in the shared
// ModelRegistry. When the parent later delivers a tool result, it would call
// the subagent's `streamSimple` (which has empty state) instead of its own.
//
// By storing the active streamSimple in a Symbol.for() global (shared across all
// module instances), we ensure only the FIRST instance to register takes effect.
// Subsequent instances wrap the stored function instead of overwriting it.
//
// Only the owning session's shutdown releases this.
// Child lifecycle events must not release the parent's routing function.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const MODELS = buildModels(getModels("anthropic"));
let providerSettings: NonNullable<Config["provider"]> = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false, contextWindow: "auto" };

function resolveModel(input: string) {
	return _resolveModel(MODELS, input);
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// AskClaude mode presets — controls which CC tools are blocked per mode.
// Only block tools that can't work (no OMP TUI for user interaction).
// Other CC tools (Agent, SendMessage, RemoteTrigger, Tasks, etc.) are intentionally not blocked.
const ASKCLAUDE_ALWAYS_BLOCKED = [
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
	"ToolSearch", // probes for blocked tools, wastes tokens
	"ScheduleWakeup", // no harness to fire wakeup from inside a delegated subagent
];
const MODE_DISALLOWED_TOOLS: Record<string, string[]> = {
	full: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
	],
	read: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Write", "Edit", "Bash", "NotebookEdit",
		"EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	],
	none: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
		"NotebookEdit", "EnterWorktree", "ExitWorktree",
		"CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
		"WebFetch", "WebSearch",
	],
};

// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

let sharedSession: SessionState | null = null;
let sessionGeneration = 0;
let mainSessionManager: ExtensionContext["sessionManager"] | undefined;

// Convert pi messages to Anthropic API format for session import.
// Lossy: non-Anthropic thinking blocks are dropped (no valid signature), and only
// text/image/toolCall block types are handled. If all blocks in an assistant message
// are filtered, the message is dropped — which can create invalid sequences (e.g.
// two user messages in a row, or tool_result without preceding tool_use).
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
): void {
	const { anthropicMessages, sanitizedIds, droppedThinking } = convertPiMessages(messages, customToolNameToSdk, providerSettings.replayThinking ?? "last");
	if (droppedThinking) debug(`convertAndImportMessages: dropped ${droppedThinking} historical thinking block(s) (replayThinking=${providerSettings.replayThinking ?? "last"})`);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// Repair once before the lossless importer writes the full content blocks.
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	if (repaired.length) importMessagesLossless(session, repaired);
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Extract the last user message from context as a prompt string. Returns null if last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function systemPromptText(systemPrompt: Context["systemPrompt"] | string | undefined): string | undefined {
	if (!systemPrompt) return undefined;
	return Array.isArray(systemPrompt) ? systemPrompt.join("\n\n") : systemPrompt;
}


function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(messages);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

function resultErrorText(message: SDKMessage): string {
	const result = message as SDKMessage & { subtype?: string; errors?: unknown; error?: unknown };
	if (Array.isArray(result.errors)) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code summary failed: ${result.subtype ?? "unknown result"}`;
}

function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

const isolatedCompleteImpl = (
	model: Parameters<typeof isolatedStreamFn>[0],
	context: Context,
	options: SimpleStreamOptions,
): Promise<AssistantMessage> => isolatedStreamFn(model, context, options).result();

const DEFAULT_COMPACT_MODEL = "claude-sonnet-5";
const DEFAULT_COMPACT_FALLBACKS = ["claude-sonnet-5", "claude-haiku-4-5"];
const SAFEGUARD_REFUSAL = /safeguards flagged|can't respond to this message|reasoning_extraction/i;

// A safeguard refusal is not a transient error: the same request refuses again,
// and the host's automatic retry spins on it. The usual trigger through this
// bridge is omp's `snapcompact` compaction archive, whose preamble instructs the
// model to reconstruct a verbatim transcript including its own reasoning —
// Opus 5's classifier reads that as duplicating model outputs. Naming it saves
// the next person the same investigation.
function refusalAdvice(text: string, cliModel: string): string | null {
	if (!SAFEGUARD_REFUSAL.test(text)) return null;
	return (
		`${cliModel} refused this request (safeguards). It will refuse the retry too. ` +
		`If the session has been compacted, the archive omp injected is the likely trigger: ` +
		`set compaction.methodOrder without "snapcompact", then compact again — or run this turn on another model.`
	);
}

class SummaryRefusedError extends Error {
	constructor(message: string) { super(message); this.name = "SummaryRefusedError"; }
}

/** Which Claude Code models to try for a summary, in order: the configured
 *  compact model (or the session's model when "current"), then fallbacks the
 *  safeguards are less likely to trip on, never repeating one. */
function compactModelCandidates(sessionModel: Model<any>): string[] {
	const configured = providerSettings.compactModel ?? DEFAULT_COMPACT_MODEL;
	const first = configured === "current" ? claudeCodeModelId(sessionModel, longContextSettings) : configured;
	const fallbacks = providerSettings.compactFallbackModels ?? DEFAULT_COMPACT_FALLBACKS;
	return [...new Set([first, ...fallbacks])];
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const candidates = compactModelCandidates(model);
	let lastError: unknown;
	for (let i = 0; i < candidates.length; i++) {
		try {
			const text = await runIsolatedSummaryWith(candidates[i], model, context, options);
			stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
			stream.end();
			return;
		} catch (err) {
			lastError = err;
			if (options?.signal?.aborted) {
				debug("compact summary: aborted");
				stream.push({ type: "error", reason: "aborted", error: newAssistantOutput(model, "", "aborted", "Operation aborted") });
				stream.end();
				return;
			}
			if (err instanceof SummaryRefusedError) {
				// Terminal on purpose. Re-sending a refused request to a model whose
				// safeguards happen to accept it is working around a protective
				// measure, not fixing the input. Surface it and let the caller change
				// what is being asked.
				debug(`compact summary: ${candidates[i]} refused (${err.message.slice(0, 160)}); not retrying on another model`);
				piUI?.notify(`Claude bridge: ${candidates[i]} declined to summarize this conversation. Compact from another model, or reduce what is being summarized.`, "error");
				break;
			}
			break;
		}
	}
	const msg = errorMessage(lastError);
	debug("compact summary: failed on every candidate", lastError);
	stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
	stream.end();
}

/** One summary attempt on `cliModel`. Resolves with the summary text; throws
 *  SummaryRefusedError when the model's safeguards declined the prompt. */
async function runIsolatedSummaryWith(
	cliModel: string,
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): Promise<string> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = extractIsolatedSummaryPrompt(context.messages);
		const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const claudeExecutable = loadConfig(cwd).provider?.pathToClaudeCodeExecutable;
		debug(`compact summary: spawn model=${cliModel} sessionModel=${model.id} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: { ...process.env, DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				systemPrompt: context.systemPrompt,
				model: cliModel,
				maxTurns: 1,
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				if (message.subtype === "success") {
					finalText = message.result || assistantText;
				} else {
					errorText = resultErrorText(message);
				}
			}
		}

		if (wasAborted) throw new Error("Operation aborted");

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			if (SAFEGUARD_REFUSAL.test(msg)) throw new SummaryRefusedError(msg);
			throw new Error(msg);
		}

		debug(`compact summary: done model=${cliModel} textLen=${text.length}`);
		return text;
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

function reinjectPriorCompactionFileOps(branchEntries: Array<{ type: string; details?: unknown }>, preparation: { fileOps: { read: Set<string>; edited: Set<string> } }): void {
	const prior = [...branchEntries]
		.reverse()
		.find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
	debug(`compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`);
}

interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

/**
 * Ensure the shared session holds the explicit history, excluding input sent separately.
 * Returns session ID to resume from, or null if no resume needed.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
			`Please copy and paste this message into a new issue at https://github.com/elidickinson/pi-claude-bridge/issues/new` +
			(DEBUG ? ` and attach ${DEBUG_LOG_PATH}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing sharedSession (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
function syncSharedSession(
	priorMessages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
	isIsolated = false,
	forceRebuild = false,
): SyncResult {
	// Input interleaved with tool results: the results go into history and the
	// input after them, which a count-based resume cannot express.
	if (forceRebuild) debug(`syncSharedSession: pending input interleaved with tool results, rebuilding`);

	// Decide child ownership before REUSE can hand it the parent's session.
	// A live query retains context across tools, but an unexpected-stop reminder
	// starts another query. Resume the child's explicit history in its own fresh
	// snapshot, even before the main session exists. Never touch shared state or
	// prewarm here; the caller owns cleanup of this snapshot.
	if (isIsolated) {
		if (priorMessages.length > 0) {
			const session = createSession({
				projectPath: cwd,
				claudeDir: process.env.CLAUDE_CONFIG_DIR,
				...(modelId ? { model: modelId } : {}),
			});
			try {
				convertAndImportMessages(session, priorMessages, customToolNameToSdk);
				session.save();
				verifyWrittenSession(session.jsonlPath, session.sessionId, session.messages.length, cwd);
			} catch (error) {
				deleteSession(session.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
				throw error;
			}
			debug(`Case 2 synthetic: isolated history → ephemeral session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
			debug(`syncResult: path=ephemeral-resume preserve-shared isolated sessionId=${session.sessionId} priors=${priorMessages.length}`);
			return { sessionId: session.sessionId, preserveSharedSession: true };
		}
		debug(`Case 1 synthetic: isolated context, clean start${sharedSession ? `, preserving shared session ${sharedSession.sessionId.slice(0, 8)} (cursor=${sharedSession.cursor})` : ", no shared session yet"}`);
		debug(`syncResult: path=clean-start preserve-shared isolated priors=${priorMessages.length}`);
		return { sessionId: null, preserveSharedSession: true };
	}

	// Zero priors is a one-shot side request once the main session has history
	// (/new clears it via session_start). Decide ownership before rebuild flags:
	// a side request after an abort must not replace the parent's pending session.
	if (sharedSession && sharedSession.cursor > 0 && priorMessages.length === 0) {
		debug(`Case 1 synthetic: clean start for zero-prior side request, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		debug(`syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
		return { sessionId: null, preserveSharedSession: true };
	}

	// REUSE path
	//
	// Guard on priorMessages.length >= cursor: a shorter incoming context cannot
	// be a continuation of the cached session. This is the general invariant for
	// pi-side history rewrites such as /compact and session_tree: without it,
	// missed = [].slice(cursor) can falsely hit REUSE and resume an unrelated
	// longer CC session. See issue #25.
	if (sharedSession && !sharedSession.needsRebuild && !forceRebuild && priorMessages.length >= sharedSession.cursor) {
		const missed = priorMessages.slice(sharedSession.cursor);
		const trailingAssistantOnly =
			missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
			if (trailingAssistantOnly) {
				sharedSession = { ...sharedSession, cursor: priorMessages.length, cwd };
			}
			debug(`Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
			debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
			return { sessionId: sharedSession.sessionId };
		}
	}
	// A shorter MAIN context means omp rewrote its history without an event we
	// handle (pruning, cursor drift, compaction). Rebuild instead of starting
	// without history. Reentrant and zero-prior side requests returned above.
	if (sharedSession && !sharedSession.needsRebuild && !forceRebuild && priorMessages.length < sharedSession.cursor) {
		debug(`Case 4 drift: main context shorter than cursor (${priorMessages.length} < ${sharedSession.cursor}), rebuilding instead of clean start`);
	}

	// REBUILD path
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, no prior messages`);
		debug(`syncResult: path=clean-start`);
		return { sessionId: null };
	}
	const previousSessionId = sharedSession?.sessionId;
	const previousCursor = sharedSession?.cursor ?? 0;
	const rebuildRequested = sharedSession?.needsRebuild;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped only when there's a
	// concurrent writer we shouldn't race — see forceRotate docs above.
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	// A warm process may hold the JSONL we are about to rewrite.
	discardWarm("rebuild");
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, process.env.CLAUDE_CONFIG_DIR);
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk);
	session.save();
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.messages.length, cwd);
	sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd };
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		const reason = rebuildRequested ? "needsRebuild (compaction/tree/missed input)"
			: forceRebuild ? "interleaved input"
			: missedCount < 0 ? `drift, ${-missedCount} shorter than cursor` : `${missedCount} missed messages`;
		debug(`Case 4: ${reason}, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.messages.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.messages.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId };
}

// @internal
export const __test = {
	resetSharedSession() {
		sharedSession = null;
	},
	setSharedSession(state: SessionState | null) {
		sharedSession = state;
	},
	getSharedSession() {
		return sharedSession;
	},
	syncSharedSession,
	streamClaudeAgentSdk,
	getMainQueryContext: ctx,
	clearSession() {
		clearSession();
		releaseSessionOwner();
	},
	promptAndWait,
	setStreamFactory(factory: () => AssistantMessageEventStream) {
		const previous = newAssistantMessageEventStream;
		newAssistantMessageEventStream = factory;
		return previous;
	},
};

// --- Provider helpers: tool name mapping ---

// Provider path: the query runs with `tools: []`, so the only tools CC can
// legitimately call are the omp tools served over MCP. Any other name is the
// model hallucinating a builtin (`bash`, `Bash`, `Edit`...). CC answers those
// itself with "No such tool available" and retries inside the same query,
// never dispatching them to our MCP server — so such a call must not reach
// omp. Forwarding one ran a tool CC never dispatched (real side effects) and,
// because the retry carries a fresh tool_use id, deadlocked both sides.
function piToolNameFor(name: string, customToolNameToPi: Map<string, string> | undefined): string | undefined {
	if (!customToolNameToPi) return mapToolName(name);
	return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
}

function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// Pi bash has no default timeout; add a safety default
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}

// --- Provider helpers: tool resolution ---

// --- Provider helpers: tool bridge ---

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
let piUI: ExtensionUIContext | null = null;
const activeQueryContexts = new Set<QueryContext>();

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (!queryCtx.activeQuery) continue;
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Claude Code renders at most CC_MCP_DESCRIPTION_LIMIT characters of an MCP
// tool description. Long omp descriptions are condensed to fit (see
// tool-description.ts) and their full text goes here, into the system prompt.
function buildToolReference(tools: Tool[]): string | undefined {
	const long = tools.filter((t) => (t.description ?? "").length > CC_MCP_DESCRIPTION_LIMIT);
	if (!long.length) return undefined;
	const sections = long.map((t) => `## ${MCP_TOOL_PREFIX}${t.name}\n${t.description}`);
	return `${TOOL_REFERENCE_HEADER}\nClaude Code truncates MCP tool descriptions at ${CC_MCP_DESCRIPTION_LIMIT} characters. These are the complete descriptions of the tools affected; follow them, including the examples.\n\n${sections.join("\n\n")}`;
}

// The host's own system prompt (omp: tool inventory, todo/task workflow,
// delegation rules, edit conventions). Claude Code's preset knows nothing of
// it, so without this the model works like Claude Code with odd tool names.
// Minimal identity for "host" system-prompt mode (no Claude Code preset).
const HOST_ONLY_PROMPT_HEADER = "You are Claude, running as the model behind the Oh My Pi (omp) coding harness. The harness instructions below are your complete operating instructions.";

function buildHostPromptAppend(hostPrompt: string | undefined): string | undefined {
	const text = hostPrompt?.trim();
	if (!text) return undefined;
	return `# Host harness instructions (Oh My Pi)\nYou are running inside the Oh My Pi (omp) harness. Its tools are exposed to you as MCP tools named \`${MCP_TOOL_PREFIX}<name>\` (e.g. \`${MCP_TOOL_PREFIX}edit\`, \`${MCP_TOOL_PREFIX}todo\`, \`${MCP_TOOL_PREFIX}task\`); where the instructions below say \`edit\`, \`todo\`, \`task\`... they mean those MCP tools. Claude Code's own Read/Edit/Bash/TodoWrite tools are not available. The instructions below take precedence over generic Claude Code workflow guidance.\n\n${text}`;
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers are assigned toolCallIds from turnToolCallIds (populated when the SDK
// emits tool_use blocks). Results are matched by ID, not position.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
// Serves omp's TypeBox schemas to Claude Code verbatim (see mcp-server.ts):
// the SDK's createSdkMcpServer only takes Zod, and the JSON Schema → Zod round
// trip flattened every nested object to an open record and dropped anyOf/const,
// so Claude saw only the top level of todo.list[], task.tasks[], edit ops...
// Results are paired by Claude Code's own tool_use id (_meta), not call order.
function buildMcpServers(tools: Tool[], queryCtx: QueryContext, hasToolReference = true): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	// Claude Code renders at most ~2048 chars of an MCP tool description into
	// the prompt; longer omp descriptions (edit, task, todo...) reach the model
	// cut off. Log the sizes so the loss is visible.
	if (DEBUG) {
		const sizes = tools.map((t) => `${t.name}=${(t.description ?? "").length}${(t.description ?? "").length > 2048 ? "!" : ""}`);
		debug(`mcp tools (${tools.length}, ! = description > 2048 chars, truncated by Claude Code): ${sizes.join(" ")}`);
		try { writeFileSync(join(dirname(DEBUG_LOG_PATH), "claude-bridge-tools.json"), JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description })), null, 2)); } catch { /* best effort */ }
	}
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: packToolDescription(tool.description, CC_MCP_DESCRIPTION_LIMIT, hasToolReference) ?? "",
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

// --- Usage helpers ---

function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	// Claude Code may report reasoning/thinking tokens separately, while pi's Usage type does not model that field.
	const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
	if (reasoning != null) (output.usage as typeof output.usage & { reasoning?: number }).reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

// --- Effort level mapping ---
// OMP reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current OMP stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.

const completedStreams = new WeakSet<object>();

function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream as object);
}

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const reason = stopReason === "length" ? "length" : "stop";
	const stream = c.currentPiStream;
	stream!.push({ type: "done", reason, message: c.turnOutput });
	markStreamComplete(stream);
	stream!.end();
	c.currentPiStream = null;
}

/** Maps Anthropic stream events to OMP stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		c.turnToolCallIds = [];
		c.nextHandlerIdx = 0;
		if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				debug(`processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`);
				return;
			}
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(c.turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this OMP stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream!.end();
		c.currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	if (c.turnSawStreamEvent) return;
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	c.turnToolCallIds = [];
	c.nextHandlerIdx = 0;
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: piName,
				arguments: mapToolArgs(piName, block.input),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
async function consumeQuery(
	sdkQuery: Query,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
	captureSessionId: (sessionId: string) => void,
): Promise<void> {
	let capturedSessionId: string | undefined;

	try {
	for await (const message of sdkQuery) {
		// Retain the ID for cleanup even if a later message throws, the host
		// stream already ended on tool_use, or an abort arrived before init.
		if (message.type === "system" && message.subtype === "init" && message.session_id) {
			capturedSessionId = message.session_id;
			captureSessionId(capturedSessionId);
		}
		if (wasAborted()) break;
		// Nothing else closes the CLI's stdin now that the prompt is a parked
		// generator: end it on the result, and do it before the stream guard
		// below (a result can arrive with no live pi stream) or the query hangs.
		if (message.type === "result") queryCtx.promptStream?.end();
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result":
				logServedContextWindow("result", message, model);
				// A result flagged is_error (usage limit, billing, auth…) must surface as a
				// turn error so the host can retry / walk its fallback chain, instead of
				// being finalized as a normal stop with the error text as assistant output.
				if ((message as any).is_error === true) {
					const apiStatus = (message as any).api_error_status as number | null | undefined;
					const errors = (message as any).errors as string[] | undefined;
					const text = (errors && errors.length > 0 ? errors.join("; ") : (message as any).result) || `Claude Code result ${message.subtype}`;
					debug(`consumeQuery: result is_error subtype=${message.subtype} api_error_status=${apiStatus} text=${String(text).slice(0, 200)}`);
					if (apiStatus === 429 || /hit your limit|usage limit|rate limit/i.test(String(text))) {
						throw new ClaudeUsageLimitError(`429 usage_limit_reached: ${text}`);
					}
					const advice = refusalAdvice(String(text), model.id);
					if (advice) {
						debug(`consumeQuery: safeguard refusal on ${model.id}`);
						piUI?.notify(advice, "error");
						throw new Error(`${text}\n\n${advice}`);
					}
					throw new Error(apiStatus ? `${apiStatus} ${text}` : String(text));
				}
				if (!queryCtx.turnSawStreamEvent && message.subtype === "success") {
					ensureTurnStarted(queryCtx);
					const text = message.result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			case "system":
				break;
			case "user":
				break; // SDK echo of user prompt — not needed
			case "rate_limit_event": {
				const info = (message as any).rate_limit_info;
				debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
				// Quota reporting is built from these events alone — see usage.ts.
				recordRateLimitEvent(info);
				const notice = rateLimitNotice(info);
				if (notice) piUI?.notify(notice.message, notice.level);
				// Hard rejection: abort the turn with a 429 usage-limit error so the host
				// marks this provider exhausted and switches to its configured fallback.
				const limitError = usageLimitError(info);
				if (limitError) throw limitError;
				break;
			}
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	} finally {
		// Settle any push still parked on the generator; nothing will drain it now.
		queryCtx.promptStream?.fail(new Error("query ended"));
		queryCtx.promptStream = null;
	}

	// DEBUG: trace when consumeQuery exits
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);
}

// --- Pre-warmed next process ---
//
// Spawning Claude Code and resuming the session costs ~1.7 s before the API
// call (measured: spawn 0.4 s + init 1.3 s). After a main-thread turn ends,
// the next turn's options are almost always the same (model, effort, tools,
// resume id), so we spawn that process now with startup() and hand it the
// prompt when it arrives. Anything that could make the warm process wrong —
// a rebuild (its JSONL gets rewritten), a session clear, a different model /
// effort / tool set, or simply too much idle time — discards it.
interface WarmProcess {
	handle: WarmQuery;
	key: string;
	createdAt: number;
	timer: ReturnType<typeof setTimeout>;
}
let warmProcess: WarmProcess | null = null;
// Bumped by every discard. A startup() still in flight when that happens
// belongs to a superseded generation: its handle is closed on arrival instead
// of being published, which is otherwise how a process discarded on shutdown
// or rebuild comes back to life a second later.
let warmGeneration = 0;
const WARM_TTL_MS = 10 * 60_000;

// A stable digest of a string. Not cryptographic: it only has to change when
// the string does, and a prompt's length plus its first 80 characters does not
// (omp's host-prompt header alone is longer than that, and two prompts of the
// same length would collide).
function digest(value: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
	}
	return `${value.length}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

// Everything the warm process baked in at startup. A tool whose description or
// schema changed between turns is a different tool set even under the same
// name, so the definitions go in, not just the names.
function warmKey(opts: Record<string, unknown>, mcpTools: Tool[]): string {
	const extra = (opts.extraArgs ?? {}) as Record<string, unknown>;
	const sys = opts.systemPrompt;
	return JSON.stringify({
		model: extra.model,
		extraArgs: extra,
		effort: opts.effort ?? null,
		resume: opts.resume ?? null,
		cwd: opts.cwd,
		settings: opts.settingSources ?? null,
		env: digest(JSON.stringify(opts.env ?? null)),
		sys: digest(typeof sys === "string" ? sys : JSON.stringify(sys ?? null)),
		tools: digest(JSON.stringify(mcpTools.map((t) => [t.name, t.description, t.parameters]))),
	});
}

function discardWarm(reason: string): void {
	warmGeneration++;
	if (!warmProcess) return;
	debug(`prewarm: discarding (${reason}), age=${Math.round((Date.now() - warmProcess.createdAt) / 1000)}s`);
	clearTimeout(warmProcess.timer);
	try { warmProcess.handle.close(); } catch { /* already gone */ }
	warmProcess = null;
}

/** Spawn the next process in the background. `opts` is the options object the
 *  next fresh query would build; the caller passes fresh mcpServers bound to
 *  the top-level QueryContext. Never throws: a failed warm-up costs nothing. */
function scheduleWarm(opts: Record<string, unknown>, mcpTools: Tool[]): void {
	if (providerSettings.prewarm === false) return;
	discardWarm("replaced");
	const key = warmKey(opts, mcpTools);
	const startedAt = Date.now();
	const generation = warmGeneration;
	startup({ options: { ...(opts as object), ...makeCliDebugOptions("prewarm") } as any, initializeTimeoutMs: 30_000 })
		.then((handle) => {
			if (generation !== warmGeneration) {
				debug(`prewarm: ready but its generation was discarded; closing`);
				try { handle.close(); } catch { /* ignore */ }
				return;
			}
			if (warmProcess) { try { handle.close(); } catch { /* ignore */ } return; }
			const timer = setTimeout(() => discardWarm("ttl"), WARM_TTL_MS);
			warmProcess = { handle, key, createdAt: Date.now(), timer };
			debug(`prewarm: ready in ${Date.now() - startedAt}ms, resume=${String(opts.resume ?? "none").slice(0, 8)} model=${String((opts.extraArgs as any)?.model)} effort=${String(opts.effort ?? "default")}`);
		})
		.catch((error) => debug(`prewarm: startup failed:`, error));
}

/** Take the warm process if it matches what this query needs, else null. */
function takeWarm(key: string): WarmQuery | null {
	if (!warmProcess) return null;
	if (warmProcess.key !== key) {
		debug(`prewarm: key mismatch, discarding`);
		discardWarm("key mismatch");
		return null;
	}
	const { handle, timer, createdAt } = warmProcess;
	clearTimeout(timer);
	warmProcess = null;
	debug(`prewarm: using warm process (age=${Math.round((Date.now() - createdAt) / 1000)}s)`);
	return handle;
}

/** The user/developer messages omp added during this tool round (steers typed
 *  while a tool ran, harness reminders), as one user turn's blocks, or null.
 *  Starts past both the last assistant turn and whatever this query already
 *  delivered, so a repeated callback does not resend them. */
function steerBlocks(messages: Context["messages"], c: QueryContext): ContentBlockParam[] | null {
	const { blocks } = splitPendingInput(messages, c.latestCursor);
	return blocks.length ? (blocks as ContentBlockParam[]) : null;
}

/** A steer that never made it into CC's session. The cursor has already counted
 *  it, so count-based sync would skip it forever — rebuild instead, which
 *  re-imports the message from omp's context. Only the main conversation's
 *  session is marked: a subagent's lost steer is not the parent's. The query
 *  context keeps the flag too, for a first query that has no session yet. */
function steerMissedSession(c: QueryContext, text: string): void {
	if (!c.ownsSharedSession) {
		debug(`provider: steer never reached an isolated query, not marking the shared session: ${text.slice(0, 60)}`);
		return;
	}
	c.inputMissed = true;
	if (sharedSession) sharedSession = { ...sharedSession, needsRebuild: true };
	debug(`provider: steer never reached CC, marked session for rebuild: ${text.slice(0, 60)}`);
}

/** Releases this turn's tool results to their MCP handlers, after first pushing
 *  any steer to CC.
 *
 *  The ordering is mandatory: the steer and the MCP tool result travel back to
 *  CC over the same stdin FIFO. Awaiting the push ack (resolves once the SDK's
 *  write to stdin completed) before resolving any handler guarantees CC
 *  enqueues the steer before it reads the tool result, so its post-tool-call
 *  drain sees it and acts on it this turn. Resolve first and the steer misses
 *  the drain, degrading to follow-up semantics. (Ported from upstream 0.7.0.) */
async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	contextLength: number,
): Promise<void> {
	if (steer) {
		const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		if (!c.promptStream) {
			debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
			steerMissedSession(c, text);
		} else {
			try {
				await c.promptStream.push(userMessage(steer, "next"));
				debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
			} catch (error) {
				// The query is ending — pushing further input would wedge tool-result
				// delivery, so the steer doesn't reach this query. It is still in
				// omp's context and the cursor already counts it: force a rebuild.
				debug(`provider: steer push rejected, delivering tool result anyway:`, error);
				steerMissedSession(c, text);
			}
		}
	}

	debug(`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
	}
	// Disjoint IDs can legitimately be queued while other handlers wait. Only
	// the same ID in both maps means a deliverable result was left unresolved.
	for (const id of c.pendingResults.keys()) {
		if (c.pendingToolCalls.has(id)) debug(`BUG: unmatched tool result and handler for [${id}] after delivery`);
	}
	if (c.pendingToolCalls.size > 0) {
		debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		piUI?.notify(`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}
}

/** Settle everything that could be parked on an aborted query: an in-flight
 *  prompt-stream push would hang forever and take tool-result delivery with it. */
function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
	promptStream.fail(new Error("Operation aborted"));
	for (const pending of c.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Operation aborted" }] }); }
	c.pendingToolCalls.clear();
	c.pendingResults.clear();
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();

	// omp runEphemeralTurn assigns a separate routing lineage to recap, /btw
	// and other side turns, while deliberately sharing the prompt-cache key.
	// Use that host metadata, not prompt text, model or history length. Classify
	// BEFORE matching tool IDs: a side snapshot can contain the parent's results.
	const isSideRequest = /^[^:]+:side:.+$/.test(options?.sessionId ?? "");

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	const activeQuery = ctx().activeQuery !== null;
	const allResults = isSideRequest ? [] : extractAllToolResults(context);
	const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		// A duplicate callback (every result already delivered) must not replace the
		// waiting output stream or release handlers while the original steer push
		// still awaits its ack. Decided by result id, not context length: a mid-run
		// compaction hands over a SHORTER context carrying new results, and treating
		// it as a duplicate left Claude Code waiting on its tool call while omp got
		// an empty stop three times ("Assistant returned empty stop after retry cap").
		const newResults = allResults.filter((r) => !r.toolCallId || !resultCtx.deliveredResultIds.has(r.toolCallId));
		if (newResults.length === 0) {
			debug(`provider: duplicate tool-result callback (${allResults.length} already delivered), ending quietly`);
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, "", "stop") });
				markStreamComplete(stream);
				stream.end();
			});
			return stream;
		}
		if (context.messages.length < resultCtx.latestCursor) {
			// omp rewrote the history under the live query (mid-run compaction): the
			// delivered-input position no longer maps onto this context.
			debug(`provider: context shrank under the live query (${resultCtx.latestCursor} -> ${context.messages.length}), resetting input cursor`);
			resultCtx.latestCursor = 0;
		}
		for (const r of newResults) if (r.toolCallId) resultCtx.deliveredResultIds.add(r.toolCallId);
		claimCurrentPiStream(stream, "tool-result", resultCtx);
		resultCtx.resetTurnState(model);
		// User messages (steer / followUp) omp injected into context during the
		// active query — a steer typed while a tool ran, drained by omp at the
		// turn boundary next to the tool result. Written to Claude Code's stdin
		// BEFORE the tool results are released, so CC sees it this turn.
		// Developer messages (harness reminders) travel the same way, wrapped.
		const steer = steerBlocks(context.messages, resultCtx);
		void deliverToolResults(resultCtx, newResults, steer, context.messages.length);

		// Only the main conversation's tool results advance the shared cursor: a
		// subagent's context is shorter, and letting it write here dragged the
		// cursor backwards (40 -> 3 in a reproduction), so the parent's next turn
		// resumed a session that no longer matched its history.
		if (sharedSession && resultCtx.ownsSharedSession) sharedSession.cursor = Math.max(sharedSession.cursor, context.messages.length);
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		return stream;
	}

	// New input for this call: every user/developer message after the last
	// assistant turn (a prompt, harness reminders, a steer that missed its query).
	const pendingInput = splitPendingInput(context.messages);

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message. Unless input is
	// waiting next to the result (a reminder omp added before it): that goes to
	// a fresh query, with the result rebuilt into history, instead of vanishing.
	const lastMsg = context.messages[context.messages.length - 1];
	if (allResults.length > 0 && (pendingInput.blocks.length === 0 || options?.signal?.aborted)) {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		if (sharedSession && !activeQuery) {
			if (pendingInput.blocks.length > 0) sharedSession = { ...sharedSession, needsRebuild: true };
			else sharedSession.cursor = Math.max(sharedSession.cursor, context.messages.length);
		}
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, "", "stop") });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---

	// Side turns need a private context even while idle: a real main turn can
	// start before the side request completes and must retain the main context.
	const isReentrant = activeQuery;
	const isIsolated = isReentrant || isSideRequest;
	const queryCtx = isIsolated ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, sideChannel=${isSideRequest}, activeContexts=${activeQueryContexts.size}`);

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = 0;
	queryCtx.deliveredResultIds.clear();
	queryCtx.inputMissed = false;

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);
	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const claudeDir = process.env.CLAUDE_CONFIG_DIR;
	const parentSessionId = sharedSession?.sessionId;
	const promptBlocks = pendingInput.blocks.length ? (pendingInput.blocks as ContentBlockParam[]) : null;
	let promptText = "";
	if (pendingInput.pendingIndices.length > 1 || context.messages[pendingInput.pendingIndices[0]]?.role === "developer") {
		debug(`provider: prompt from ${pendingInput.pendingIndices.length} pending message(s): ${pendingInput.pendingIndices.map((i) => `[${i}]${context.messages[i].role}`).join(" ")}${pendingInput.interleaved ? " (interleaved)" : ""}`);
	}

	// Guard: no user or developer content after the last assistant turn.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: sharedSession ? { sessionId: sharedSession.sessionId.slice(0, 8), cursor: sharedSession.cursor } : null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	// Always stream the prompt rather than passing a string: a parked input
	// generator is what lets us write steers to CC's stdin mid-turn. The cost is
	// that the SDK no longer closes stdin on the first result — consumeQuery
	// ends the stream explicitly instead, or the query would never terminate.
	const promptStream = makePromptStream();
	void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
		.catch((error) => debug(`provider: initial prompt push rejected:`, error));
	queryCtx.promptStream = promptStream;
	const prompt: AsyncIterable<SDKUserMessage> = promptStream.stream;
	const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
	const forwardHostPrompt = appendSystemPrompt && providerSettings.forwardHostPrompt !== false;
	const mcpServers = buildMcpServers(mcpTools, queryCtx, forwardHostPrompt);
	const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
	const skillsAppend = appendSystemPrompt ? extractSkillsBlock(systemPromptText(context.systemPrompt)) : undefined;
	if (DEBUG) { try { writeFileSync(join(dirname(DEBUG_LOG_PATH), "claude-bridge-sysprompt.txt"), systemPromptText(context.systemPrompt) ?? ""); } catch { /* best effort */ } }
	const hostPromptAppend = forwardHostPrompt ? buildHostPromptAppend(systemPromptText(context.systemPrompt)) : undefined;
	const toolReferenceAppend = forwardHostPrompt ? buildToolReference(mcpTools) : undefined;
	const appendParts = [hostPromptAppend, toolReferenceAppend, agentsAppend, skillsAppend].filter((part): part is string => Boolean(part));
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
	// "host" mode: Claude Code runs on the host prompt alone. Falls back to the
	// preset when there is nothing to forward (no host prompt in context).
	const hostOnlyPrompt = providerSettings.systemPrompt === "host" && hostPromptAppend
		? [HOST_ONLY_PROMPT_HEADER, systemPromptAppend].join("\n\n")
		: undefined;

	// MCP auto-loading suppression: CC reads MCP servers from ~/.claude.json (top-level
	// + per-project) and .mcp.json. Since pi executes tools (not CC), those are pure
	// token overhead. --strict-mcp-config tells the binary to use ONLY mcpServers passed
	// programmatically and ignore filesystem MCP entries — applied unconditionally because
	// settingSources=undefined does NOT give isolation (the CC default loads all sources).
	// When the host prompt is forwarded, isolate the Claude Code child from
	// ~/.claude: user settings bring the user's plugins, hooks and skills
	// (seconds of startup per turn, tokens, and hooks firing inside omp turns
	// that omp knows nothing about). "project" keeps the repo's CLAUDE.md.
	const settingSources: SettingSource[] | undefined = providerSettings.settingSources
		?? (forwardHostPrompt ? ["project"] : appendSystemPrompt ? undefined : ["user", "project"]);
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	// Prefer the model's own thinkingLevelMap when present (pi-ai 0.72+ ships
	// per-model overrides — e.g. opus-4-7 wants xhigh→xhigh, not xhigh→max).
	// Fall back to our generic table for older pi-ai or unmapped levels.
	const effort = options?.reasoning
		? ((model as any).thinkingLevelMap?.[options.reasoning] as EffortLevel | undefined)
			?? REASONING_TO_EFFORT[options.reasoning]
		: undefined;

	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = claudeCodeModelId(model, longContextSettings);
	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in default export). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	// The child inherits this process's environment, and a few Anthropic
	// variables silently change where its requests go or how they are billed:
	// ANTHROPIC_BASE_URL points Claude Code at a different endpoint, and an API
	// key makes it bill per token instead of using the subscription. Neither is
	// this extension's doing, but both are worth saying out loud once, because
	// the whole point of running through Claude Code is that the session stays
	// the one Anthropic issued it to.
	warnAboutRedirectingEnvOnce();
	const childEnv = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" };
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		env: childEnv,
		tools: [],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		systemPrompt: hostOnlyPrompt
			? hostOnlyPrompt
			: {
				type: "preset", preset: "claude_code",
				append: systemPromptAppend ? systemPromptAppend : undefined,
				// Keep cwd / git-status / memory-path out of the cached system block:
				// every git transition otherwise rewrites the whole prefix (upstream #73).
				excludeDynamicSections: true,
			},
		extraArgs,
		...(effort ? { effort } : {}),
		...(settingSources ? { settingSources } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};

	let resumeSessionId: string | null = null;
	let capturedSessionId: string | undefined;
	let ownsSharedSession = !isIsolated;
	const generation = sessionGeneration;
	const canUpdateSharedSession = () => ownsSharedSession && generation === sessionGeneration;
	const cleanupEphemeralSessions = () => {
		if (ownsSharedSession) return;
		if (resumeSessionId && resumeSessionId !== parentSessionId && resumeSessionId !== sharedSession?.sessionId) {
			deleteSession(resumeSessionId, cwd, claudeDir);
			debug(`provider: deleted ephemeral resume session ${resumeSessionId.slice(0, 8)}`);
		}
		if (capturedSessionId && capturedSessionId !== resumeSessionId && capturedSessionId !== parentSessionId && capturedSessionId !== sharedSession?.sessionId) {
			deleteSession(capturedSessionId, cwd, claudeDir);
			debug(`provider: deleted ephemeral captured session ${capturedSessionId.slice(0, 8)}`);
		}
	};

	// 3. Import and start the SDK query under one cleanup boundary. Construct
	// options first so an earlier setup error cannot strand an imported file.
	let wasAborted = false;
	let sdkQuery: Query;
	try {
		const syncResult = syncSharedSession(pendingInput.history as Context["messages"], cwd, customToolNameToSdk, model.id, isIsolated, pendingInput.interleaved);
		resumeSessionId = syncResult.sessionId;
		ownsSharedSession = !isIsolated && !syncResult.preserveSharedSession;
		queryCtx.ownsSharedSession = ownsSharedSession;
		if (resumeSessionId) queryOptions.resume = resumeSessionId;
		// Rebuild child history from omp each time. Disable CLI writes so
		// abort/startup failure cannot leave or recreate an isolated transcript.
		if (!ownsSharedSession) queryOptions.persistSession = false;
		debug("provider: fresh query",
			`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
			`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"} reasoning=${options?.reasoning ?? "none"}`,
			`appendSys=${appendSystemPrompt} sysPrompt=${hostOnlyPrompt ? "host" : "preset"} settings=${settingSources ? JSON.stringify(settingSources) : "all"} strictMcp=${strictMcpConfigEnabled}`,
			`prompt=${(promptBlocks ? promptBlocks.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ") : promptText).slice(0, 60)}`);
		const warm = ownsSharedSession ? takeWarm(warmKey(queryOptions as Record<string, unknown>, mcpTools)) : null;
		sdkQuery = warm ? warm.query(prompt) : query({ prompt, options: queryOptions });
	} catch (error) {
		promptStream.fail(error instanceof Error ? error : new Error(String(error)));
		queryCtx.promptStream = null;
		queryCtx.currentPiStream = null;
		cleanupEphemeralSessions();
		throw error;
	}
	queryCtx.activeQuery = sdkQuery;
	activeQueryContexts.add(queryCtx);

	// 4. Capture context for abort handling
	const abortCtx = queryCtx;

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	const onAbort = () => {
		wasAborted = true;
		if (canUpdateSharedSession()) discardWarm("abort");
		drainForAbort(abortCtx, promptStream);
		abortCtx.pendingToolCalls.clear();
		abortCtx.pendingResults.clear();
		requestAbort();
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Background consumer — runs until query ends
	consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx, (id) => { capturedSessionId = id; })
		.finally(() => {
			if (ownsSharedSession) return;
			// Close before deleting, and clean up before publishing a terminal
			// stream event. This runs on success, abort and consumer errors,
			// including failures before the SDK reports its init/session ID.
			try { sdkQuery.close(); } finally { cleanupEphemeralSessions(); }
		})
		.then(() => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

			// --- Abort detection in normal completion path ---
			if (wasAborted || options?.signal?.aborted) {
				if (canUpdateSharedSession() && sharedSession) sharedSession = { ...sharedSession, needsRebuild: true, forceRotate: true };
				debug(`provider: abort detected${canUpdateSharedSession() ? ", marked sharedSession needsRebuild + forceRotate" : ", preserving sharedSession"}`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = "Operation aborted";
				}
				const stream = queryCtx.currentPiStream;
				stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
				return;
			}

			// --- Capture session ID ---
			const sessionId = capturedSessionId ?? sharedSession?.sessionId;
			// Children/side turns never publish shared state. Nor may an old main
			// query resurrect a session cleared by a real transition or shutdown.
			if (!canUpdateSharedSession()) {
				debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session${isSideRequest ? " (side-channel)" : isReentrant ? " (reentrant)" : ""}`);
			} else if (sessionId) {
				const cursor = Math.max(context.messages.length, queryCtx.latestCursor, sharedSession?.cursor ?? 0);
				// Spread first: a compaction / tree event that fired while this
				// query was finishing set needsRebuild on the old object, and
				// dropping it here silently undid the compaction (upstream #62).
				// A steer that never reached CC is in omp's history and counted by the
				// cursor but not in the JSONL: only a rebuild brings it back. Also on
				// the first query, when there was no session to mark at the time.
				const needsRebuild = sharedSession?.needsRebuild || queryCtx.inputMissed;
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}${sharedSession?.needsRebuild ? " needsRebuild kept" : queryCtx.inputMissed ? " needsRebuild (missed input)" : ""}`);
				sharedSession = { ...sharedSession, sessionId, cursor, cwd, ...(needsRebuild ? { needsRebuild: true } : {}) };
			}


			if (!isIsolated && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);

			// Pre-spawn the next process: same options, resuming the session this
			// turn just extended. Only for a clean main-thread stop with a session
			// to resume and no pending rebuild (a rebuild rewrites the JSONL the
			// warm process would be reading).
			if (canUpdateSharedSession() && sharedSession && !sharedSession.needsRebuild && queryCtx.turnOutput?.stopReason === "stop") {
				const nextOptions = {
					...queryOptions,
					resume: sharedSession.sessionId,
					mcpServers: buildMcpServers(mcpTools, ctx(), forwardHostPrompt),
				};
				scheduleWarm(nextOptions as Record<string, unknown>, mcpTools);
			}
		})
		.catch((error) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			if (canUpdateSharedSession()) {
				discardWarm("query error");
				if ((wasAborted || options?.signal?.aborted) && sharedSession) {
					sharedSession = { ...sharedSession, needsRebuild: true, forceRotate: true };
				} else {
					sharedSession = null;
				}
			}
			if (queryCtx.turnOutput) {
				queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
				queryCtx.turnOutput.errorMessage = error instanceof Error ? error.message : String(error);
				if (error instanceof ClaudeUsageLimitError) queryCtx.turnOutput.errorStatus = error.status;
			}
			if (!isIsolated && queryCtx.activeQuery === sdkQuery) {
				for (const pending of queryCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Query ended" }] }); }
				queryCtx.pendingToolCalls.clear();
				queryCtx.pendingResults.clear();
				debug("provider: clearing activeQuery before error stream completion");
				queryCtx.activeQuery = null;
			}
			const stream = queryCtx.currentPiStream;
			stream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
			markStreamComplete(stream);
			stream?.end();
			queryCtx.currentPiStream = null;
		})
		.finally(() => {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			if (queryCtx.activeQuery === sdkQuery) {
				// Drain pending handlers for this query
				for (const pending of queryCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Query ended" }] }); }
				queryCtx.pendingToolCalls.clear();
				queryCtx.pendingResults.clear();
				queryCtx.activeQuery = null;
			}
			// Ending the stream can start the next query before this finally runs.
			if (!queryCtx.activeQuery) activeQueryContexts.delete(queryCtx);
			if (ownsSharedSession) sdkQuery.close();
		});

	return stream;
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		appendSkills?: boolean;
		onStreamUpdate?: (responseText: string) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		history?: Context["messages"];
	},
): Promise<{ responseText: string; stopReason: string }> {
	const cwd = process.cwd();
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(requestedModel);
	const modelId = model?.id ?? requestedModel;
	const cliModel = model ? claudeCodeModelId(model, longContextSettings) : modelId;

	// Session resume for shared mode — reuse provider's session if it exists,
	// otherwise create one from pi's context.
	// Note: doesn't update sharedSession.cursor after completion, so the next
	// provider call will see missed messages and trigger a Case 4 rebuild.
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.history?.length) {
		// Resuming the existing session id assumed it already held every message
		// omp has, which is only true when the last turn went through this
		// provider. After a turn on another provider, or a compaction, the file
		// is behind and the delegation answered without the recent history it
		// promises. Run the same sync the provider path runs: it REUSEs when the
		// file is current and rebuilds when it is not.
		const sync = syncSharedSession(options.history, cwd, undefined, modelId);
		resumeSessionId = sync.sessionId;
		debug(`askClaude: shared mode, resume=${resumeSessionId?.slice(0, 8) ?? "none"} (history=${options.history.length} msgs)`);
	}

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];

	// Skills append
	const skillsBlock = options?.appendSkills !== false && options?.systemPrompt
		? extractSkillsBlock(options.systemPrompt) : undefined;

	// Effort
	const effort = options?.thinking && options.thinking !== "off"
		? REASONING_TO_EFFORT[options.thinking] : undefined;

	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: cliModel,
	};
	if (effort) extraArgs["thinking-display"] = "summarized";

	debug("askClaude:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`);

	const sdkQuery = query({
		prompt,
		options: {
			cwd,
			env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" },
			permissionMode: "bypassPermissions",
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(effort ? { effort } : {}),
			systemPrompt: skillsBlock
				? { type: "preset", preset: "claude_code", append: skillsBlock }
				: undefined,
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(options?.isolated ? { persistSession: false } : {}),
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			...makeCliDebugOptions("askclaude"),
		},
	});

	// Abort handling
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => { try { sdkQuery.close(); } catch {} });
	};
	// Throwing here used to skip the try/finally below, leaving the query we just
	// spawned without close(): an already-aborted signal (a cancelled task whose
	// tool still ran) leaked a Claude Code process.
	if (signal?.aborted) {
		onAbort();
		try { sdkQuery.close(); } catch { /* already gone */ }
		throw new Error("Aborted");
	}
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";
	let sdkMessageCount = 0;
	let textDeltaCount = 0;
	let resultSubtype: string | undefined;
	let resultError: string | undefined;

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;

			switch (message.type) {
				case "stream_event": {
					const event = (message as SDKMessage & { event: any }).event;
					// Text deltas → accumulate and stream
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
						textDeltaCount++;
						options?.onStreamUpdate?.(responseText);
					}
					// Tool call start → track for action summary progress
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						debug(`askClaude: tool_use start: ${event.content_block.name}`);
						toolCalls.set(event.content_block.id, {
							name: mapToolName(event.content_block.name),
							status: "running",
						});
					}
					break;
				}
				case "assistant": {
					// Update tool calls with full input for action summary
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, {
								name: mapToolName(block.name),
								status: "complete",
								rawInput: block.input,
							});
						}
					}
					break;
				}
				case "result": {
					resultSubtype = message.subtype;
					const r = message as any;
					if (r.usage) {
						debug(`askClaude: result usage: in=${r.usage.input_tokens} out=${r.usage.output_tokens} cacheRead=${r.usage.cache_read_input_tokens ?? 0} cacheWrite=${r.usage.cache_creation_input_tokens ?? 0} turns=${r.num_turns ?? "?"}`);
					}
					if (!responseText && message.subtype === "success" && message.result) {
						responseText = message.result;
					}
					// A result can carry a failure (usage limit, auth, execution error)
					// while the loop ends normally. Reporting that as a successful stop
					// with empty text told the caller the delegation had nothing to say.
					if (r.is_error === true || (message.subtype !== "success" && !responseText)) {
						resultError = (Array.isArray(r.errors) && r.errors.length ? r.errors.map(String).join("; ") : r.result)
							|| `Claude Code result ${message.subtype ?? "unknown"}`;
					}
					break;
				}
			}
		}

		const stopReason = wasAborted ? "cancelled" : resultError ? "error" : "stop";
		debug(`askClaude: done`,
			`stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
			`sdkMessages=${sdkMessageCount} textDeltas=${textDeltaCount} responseLen=${responseText.length}`,
			`toolCalls=${toolCalls.size}${resultError ? ` error=${resultError.slice(0, 160)}` : ""}`);
		if (resultError && !wasAborted) throw new Error(resultError);
		return { responseText, stopReason };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
	}
}

// OMP emits shutdown before aborting the agent. Invalidate shared-state writes
// from its still-unwinding queries, without interrupting their resource cleanup.
function clearSession(event = "test reset"): void {
	debug(`${event}: clearing session ${sharedSession?.sessionId?.slice(0, 8) ?? "none"}`);
	sessionGeneration++;
	sharedSession = null;
	for (const queryCtx of activeQueryContexts) queryCtx.ownsSharedSession = false;
	discardWarm(event);
}

function releaseSessionOwner(): void {
	mainSessionManager = undefined;
	piUI = null;
	const g = globalThis as Record<symbol, any>;
	if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
		debug("session_shutdown: clearing ACTIVE_STREAM_SIMPLE_KEY");
		g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
	}
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

let askClaudeToolName = "AskClaude";

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	providerSettings = config.provider ?? {};
	const contextWindowSetting = providerSettings.contextWindow;
	const contextWindow: ContextWindowMode =
		contextWindowSetting === "auto" || contextWindowSetting === "1m" || contextWindowSetting === "200k"
			? contextWindowSetting
			: "auto";
	if (contextWindowSetting != null && contextWindow !== contextWindowSetting) {
		console.error(`claude-bridge: invalid provider.contextWindow "${String(contextWindowSetting)}", using auto`);
	}
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
		contextWindow,
	};
	// Static fallback = the families Claude Code lists today; the live list from
	// fetchDynamicModels takes precedence and adds/reorders as Claude Code changes.
	const registeredModels = buildVariantModels(buildModels(getModels("anthropic"), STATIC_FALLBACK_IDS), longContextSettings);
	// Last good discovery result, so a later failed refresh never shrinks the
	// provider's model list (the host replaces it wholesale on every refresh).
	let lastDiscoveredModels: Array<Record<string, unknown>> | null = null;

	// --- Provider ---
	//
	// Guard against re-registration when the module is loaded multiple times
	// (e.g., when spawning subagents). The shared ModelRegistry would otherwise
	// overwrite the parent's streamSimple, breaking tool result delivery.
	// See ACTIVE_STREAM_SIMPLE_KEY for the full mechanism.

	const g = globalThis as Record<symbol, any>;
	// Registration is idempotent and re-runnable: it always installs the
	// OWNING instance's streamSimple (the first one to claim the global), never
	// this instance's, so a subagent re-registering cannot steal tool-result
	// delivery from its parent. It has to be re-runnable because the host drops
	// every runtime provider registered by an extension source when one of that
	// source's instances is torn down — a finished subagent takes claude-bridge
	// out of the shared registry, and the parent's next turn fails with
	// "No API key for provider: claude-bridge". This is omp's source-scoped
	// registry teardown, not upstream pi-claude-bridge's prompt-capture issue #91.
	const registerBridgeProvider = (reason: string) => {
		const streamSimple = g[ACTIVE_STREAM_SIMPLE_KEY] ?? streamClaudeAgentSdk;
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamSimple;
		debug(`provider: registering claude-bridge (${reason}, module=${moduleInstanceId}, owner=${streamSimple === streamClaudeAgentSdk ? "self" : "other instance"})`);
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge",
			models: registeredModels,
			// Live list from Claude Code's own /model picker (what the installed
			// binary and the plan actually serve); the static list above is the
			// fallback when discovery fails. omp caches the result (24 h).
			fetchDynamicModels: async () => {
				// The host treats this list as authoritative: returning nothing (or
				// throwing) would leave the provider with no models at all, which
				// surfaces as "unknown model claude-bridge/..." and "No API key for
				// provider: claude-bridge" mid-session. Discovery spawns a Claude Code
				// process and can legitimately fail (busy machine, timeout), so every
				// failure falls back to the static list instead of propagating.
				try {
					const discovered = await fetchClaudeCodeModels(providerSettings.pathToClaudeCodeExecutable, debug);
					const models = toProviderModels(discovered, getModels("anthropic") as any, longContextSettings);
					if (models.length) {
						lastDiscoveredModels = models;
						return models as any;
					}
					debug("models: Claude Code returned no usable models; keeping the previous list");
				} catch (err) {
					debug(`models: discovery failed (${err instanceof Error ? err.message : String(err)}); keeping the previous list`);
				}
				return (lastDiscoveredModels ?? registeredModels) as any;
			},
			// Cast: pi-ai AssistantMessageEventStream diamond dep between pi-coding-agent and pi-agent-core
			streamSimple: streamSimple as any,
			// Subscription quota, built from the rate-limit events Claude Code
			// reports during a turn, so `omp usage`, the status bar and
			// retry.usageAwareFallback see the 5h / 7d windows instead of only
			// learning about them on a hard 429. Nothing is fetched and no
			// credential is read: the SDK is this extension's only channel to the
			// service. A window stays unknown until a turn has reported it.
			usage: {
				id: PROVIDER_ID,
				supports: () => true,
				retainLastGoodOnFailure: true,
				async fetchUsage() {
					const report = buildUsageReport(PROVIDER_ID);
					debug(report
						? `usage: ${report.limits.map((l) => `${l.window.id}=${l.amount.used}%`).join(" ")}`
						: "usage: no window reported yet");
					return report as any;
				},
			},
		} as any);
	};
	registerBridgeProvider("activate");

	// Each runner supplies its own manager object. OMP keeps that object through
	// /new, switch and branch, even when its ID/file/parentSession changes.
	// The first start on the provider-owning module pins the main runner; child
	// starts cannot replace it, including when the main query is already idle.
	const ownsSession = (context: ExtensionContext, claim = false): boolean => {
		if (g[ACTIVE_STREAM_SIMPLE_KEY] !== streamClaudeAgentSdk) return false;
		if (claim && !mainSessionManager) mainSessionManager = context.sessionManager;
		return !!mainSessionManager && mainSessionManager === context.sessionManager;
	};
	pi.on("session_start", (_event, ctx) => {
		if (ownsSession(ctx, true)) {
			piUI = ctx.ui;
			clearSession("session_start");
		} else debug("session_start: ignoring non-owning session");
		registerBridgeProvider("session_start");
	});
	pi.on("session_switch", (event, ctx) => {
		if (ownsSession(ctx)) clearSession(`session_switch:${event.reason}`);
	});
	pi.on("session_branch", (_event, ctx) => {
		if (ownsSession(ctx)) clearSession("session_branch");
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ownsSession(ctx)) {
			clearSession("session_shutdown");
			releaseSessionOwner();
		} else if (g[ACTIVE_STREAM_SIMPLE_KEY]) {
			// A child teardown can remove this source's runtime provider. Restore
			// the living owner's callback, never resurrect one after its shutdown.
			registerBridgeProvider("session_shutdown");
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!ownsSession(ctx) || ctx.model?.baseUrl !== "claude-bridge") return undefined;
		// Default off: the takeover runs inside an extension handler, which the host
		// aborts at 30 s — not enough to summarize a real context, and a discarded
		// takeover leaves the session uncompacted (the host does not fall back to its
		// own methods on the pre-prompt path). Declining hands the summary to omp,
		// which asks for it through the normal provider path: no deadline, and it
		// arrives here as a zero-prior side request that preserves the shared session.
		if (providerSettings.compactTakeover !== true) {
			debug("session_before_compact: declining takeover; omp summarizes through the provider");
			return undefined;
		}
		debug(
			`session_before_compact: takeover isSplitTurn=${event.preparation.isSplitTurn} ` +
			`messages=${event.preparation.messagesToSummarize.length} turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		// omp aborts an extension handler at 30 s and then compacts its own way.
		// Racing past that point wastes the window: the summary is discarded and
		// the context stays uncompacted (which is how a session ends up over its
		// limit). Give up first, so omp still has time for its own methods.
		const deadlineMs = providerSettings.compactDeadlineMs ?? 25_000;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		// Losing the race has to stop the work, not just stop waiting for it: the
		// summary subprocess would otherwise keep running (and keep spending) for
		// a result nobody will read.
		const deadlineAbort = new AbortController();
		const deadline = new Promise<never>((_, reject) => {
			deadlineTimer = setTimeout(() => {
				deadlineAbort.abort();
				reject(new Error(`takeover exceeded ${deadlineMs}ms; leaving compaction to omp`));
			}, deadlineMs);
		});
		const signal = event.signal
			? (AbortSignal as unknown as { any(list: AbortSignal[]): AbortSignal }).any?.([event.signal, deadlineAbort.signal]) ?? event.signal
			: deadlineAbort.signal;
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await Promise.race([
				compact(
					event.preparation,
					ctx.model,
					undefined,
					event.customInstructions,
					signal,
					{ completeImpl: isolatedCompleteImpl },
				),
				deadline,
			]);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			// Declining (undefined) rather than cancelling: omp then runs its own
			// method order, whose first entries (snapcompact, shake) need no model
			// call at all. Cancelling left the context uncompacted, which is worse.
			debug("session_before_compact: takeover failed; declining so omp compacts its own way", err);
			ctx.ui?.notify?.(`Claude bridge summary unavailable (${msg}); omp will compact on its own.`, "warning");
			return undefined;
		} finally {
			if (deadlineTimer) clearTimeout(deadlineTimer);
		}
	});

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history.
	const markRebuild = (event: string) => {
		if (sharedSession) {
			debug(`${event}: marking needsRebuild on session ${sharedSession.sessionId.slice(0, 8)}`);
			sharedSession = { ...sharedSession, needsRebuild: true };
		}
	};
	pi.on("session_compact", (event, ctx) => {
		if (!ownsSession(ctx)) return;
		discardWarm("session_compact");
		markRebuild(`session_compact:fromExtension=${event.fromExtension}`);
	});
	pi.on("session_tree", (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		discardWarm("session_tree");
		markRebuild("session_tree");
	});


	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const allowFull = askConf?.allowFullMode !== false;
	const defaultMode = askConf?.defaultMode ?? "read";
	const defaultIsolated = askConf?.defaultIsolated ?? false;
	askClaudeToolName = askConf?.name ?? "AskClaude";

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	type AskClaudeToolParams = {
		prompt: string;
		mode?: "full" | "read" | "none";
		model?: string;
		thinking?: string;
		isolated?: boolean;
	};

	const readAskClaudeParams = (value: unknown, requirePrompt: boolean): AskClaudeToolParams => {
		if (!value || typeof value !== "object") {
			if (requirePrompt) throw new Error("AskClaude prompt must be a string");
			return { prompt: "" };
		}
		if (!("prompt" in value) || typeof value.prompt !== "string") {
			if (requirePrompt) throw new Error("AskClaude prompt must be a string");
			return { prompt: "" };
		}
		const parsed: AskClaudeToolParams = { prompt: value.prompt };
		if ("mode" in value && (value.mode === "full" || value.mode === "read" || value.mode === "none")) parsed.mode = value.mode;
		if ("model" in value && typeof value.model === "string") parsed.model = value.model;
		if ("thinking" in value && typeof value.thinking === "string") parsed.thinking = value.thinking;
		if ("isolated" in value && typeof value.isolated === "boolean") parsed.isolated = value.isolated;
		return parsed;
	};

	let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

	if (askConf?.enabled !== false) {
		const askClaudeParams = Type.Object({
			prompt: Type.String({ description: "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
			mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
			model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
			isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
		});
		pi.registerTool<typeof askClaudeParams>({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: askClaudeParams,
			renderCall(args, _options, theme) {
				const params = readAskClaudeParams(args, false);
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const mode = params.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== defaultMode) tags.push(`mode=${mode}`);
				if (params.model) tags.push(`model=${params.model}`);
				if (params.thinking) tags.push(`thinking=${params.thinking}`);
				if (params.isolated) tags.push("isolated");
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated = params.prompt.length > PREVIEW_MAX_CHARS ? params.prompt.substring(0, PREVIEW_MAX_CHARS) : params.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (params.prompt.length > PREVIEW_MAX_CHARS || params.prompt.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error
					? theme.fg("error", "✗ Claude Code error")
					: theme.fg("mdLink", "✓ Claude Code");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;

				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					debug("askClaude: blocked circular delegation (active provider is claude-bridge)");
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code." }],
						details: { error: true },
					};
				}

				const askParams = readAskClaudeParams(params, true);
				const mode = askParams.mode ?? defaultMode;
				const isolated = askParams.isolated ?? defaultIsolated;
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: askParams.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(askParams.prompt, mode, toolCalls, signal, {
						systemPrompt: systemPromptText(ctx.getSystemPrompt()),
						appendSkills: askConf?.appendSkills,
						model: askParams.model,
						thinking: askParams.thinking,
						isolated,
						history: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
					});
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls);

					const text = actions
						? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: askParams.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					debug(`askClaude error: mode=${mode}, model=${askParams.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: askParams.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}
}

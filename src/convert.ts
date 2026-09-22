// Pure pi→Anthropic message conversion helpers.
// Extracted so they can be tested without pulling in the full extension runtime.

import type { Message as PiMessage } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import type { Message as SessionMessage } from "cc-session-io";
import { pascalCase } from "change-case";

export const PROVIDER_ID = "claude-bridge";

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	let clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	// Substitution is lossy: "call.a" and "call/a" both become "call_a", and two
	// tool_use blocks sharing an id break the pairing with their results. Keep
	// the collision-free property by suffixing when the name is already taken.
	if (clean !== id) {
		const taken = new Set(cache.values());
		let candidate = clean;
		for (let n = 2; taken.has(candidate); n++) candidate = `${clean}_${n}`;
		clean = candidate;
	}
	cache.set(id, clean);
	return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

// --- Prompt input: user and developer messages ---
//
// omp injects harness messages with role "developer" (todo reminders, TTSR rules,
// unexpected-stop nudges). Claude Code only takes user messages, so they travel
// as user content, wrapped so the model can tell them from what the human typed.

export type PromptBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

type PiContentBlock = { type: string; text?: string; data?: string; mimeType?: string };

export const DEVELOPER_OPEN = "<system-reminder>\nMessage from the Oh My Pi harness (developer role, not typed by the user):\n";
export const DEVELOPER_CLOSE = "\n</system-reminder>";

export function isPromptRole(role: string | undefined): boolean {
	return role === "user" || role === "developer";
}

/** A user/developer message as Anthropic content blocks; images stay images.
 *  Empty for a message with no usable content. */
export function promptMessageBlocks(msg: { role: string; content?: unknown }): PromptBlock[] {
	const body: PromptBlock[] = [];
	if (typeof msg.content === "string") {
		if (msg.content) body.push({ type: "text", text: msg.content });
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content as PiContentBlock[]) {
			if (block.type === "text" && block.text) body.push({ type: "text", text: block.text });
			else if (block.type === "image" && block.data && block.mimeType) {
				body.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
			}
		}
	}
	if (msg.role !== "developer" || body.length === 0) return body;
	// Fold the markers into adjacent text blocks so a plain text reminder stays one block.
	const wrapped = [...body];
	const first = wrapped[0];
	if (first.type === "text") wrapped[0] = { type: "text", text: DEVELOPER_OPEN + first.text };
	else wrapped.unshift({ type: "text", text: DEVELOPER_OPEN.trimEnd() });
	const lastIdx = wrapped.length - 1;
	const last = wrapped[lastIdx];
	if (last.type === "text") wrapped[lastIdx] = { type: "text", text: last.text + DEVELOPER_CLOSE };
	else wrapped.push({ type: "text", text: DEVELOPER_CLOSE.trimStart() });
	return wrapped;
}

export interface PendingInput {
	/** Everything except the pending input, in order: what the CC session must hold. */
	history: PiMessage[];
	/** Indices (into the original array) of the user/developer messages after the last assistant turn. */
	pendingIndices: number[];
	/** The pending input as one user turn's content blocks. */
	blocks: PromptBlock[];
	/** Pending input is not a clean suffix: tool results sit between or after it, so
	 *  the history has to be rewritten rather than resumed. */
	interleaved: boolean;
}

/** Split a context into the history a session must hold and the new input to send.
 *  New input = every user/developer message after the last assistant message, not
 *  just the last one: omp can append several (a user prompt plus a reminder, or two
 *  reminders) before calling the provider. */
export function splitPendingInput(messages: PiMessage[], from = 0): PendingInput {
	let lastAssistant = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") { lastAssistant = i; break; }
	}
	const start = Math.max(lastAssistant + 1, from);
	const pendingIndices: number[] = [];
	for (let i = start; i < messages.length; i++) {
		if (isPromptRole(messages[i].role)) pendingIndices.push(i);
	}
	const pendingSet = new Set(pendingIndices);
	const history = messages.filter((_, i) => !pendingSet.has(i));
	// Indices are ascending and unique, so they form a clean suffix iff the first
	// one sits exactly `count` from the end.
	const interleaved = pendingIndices.length > 0 && pendingIndices[0] !== messages.length - pendingIndices.length;
	const blocks = pendingIndices.flatMap((i) => promptMessageBlocks(messages[i] as { role: string; content?: unknown }));
	return { history, pendingIndices, blocks, interleaved };
}

export type ThinkingReplay = "last" | "all" | "none";

/** Convert OMP message array to Anthropic API format. */
export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk?: Map<string, string>,
	thinkingReplay: ThinkingReplay = "last",
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string>; droppedThinking: number } {
	const anthropicMessages = [];
	const sanitizedIds = new Map();
	let droppedThinking = 0;
	// Only the turn being continued needs its thinking blocks; the API accepts
	// earlier assistant turns without them.
	let lastAssistantIndex = -1;
	for (let i = 0; i < messages.length; i++) if (messages[i].role === "assistant") lastAssistantIndex = i;

	for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
		const msg = messages[msgIndex];
		if (isPromptRole(msg.role)) {
			const parts = promptMessageBlocks(msg as { role: string; content?: unknown });
			if (parts.length) anthropicMessages.push({ role: "user", content: parts });
			// An empty developer message carries nothing; an empty user turn keeps its slot.
			else if (msg.role === "user") anthropicMessages.push({ role: "user", content: "[empty]" });
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const sig = block.thinkingSignature;
					const isAnthropicProvider = msg.provider === PROVIDER_ID || msg.api === "anthropic";
					// Historical reasoning is optional for the API, is a large share of a
					// long context's tokens, and replaying a whole session of it back to
					// Opus 5 trips its "[reasoning_extraction]" safeguard.
					const keepThinking = thinkingReplay === "all" || (thinkingReplay === "last" && msgIndex === lastAssistantIndex);
					if (isAnthropicProvider && sig && keepThinking) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					} else if (isAnthropicProvider && sig) {
						droppedThinking++;
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				}
			}
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			anthropicMessages.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			const text = typeof msg.content === "string" ? msg.content : messageContentToText(msg.content);
			anthropicMessages.push({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds), content: text || "", is_error: msg.isError }],
			});
		}
	}

	return { anthropicMessages: groupUserRuns(anthropicMessages), sanitizedIds, droppedThinking };
}

/** Write converted messages into a cc-session-io session without losing content.
 *  cc-session-io's own importMessages keeps only the tool_result blocks of a user
 *  message that has any (dropping text and images next to them) and flattens the
 *  rest to text. addUserMessage writes whatever content it is given, so passing
 *  the full block array keeps everything. Callers run repairToolPairing first. */
export function importMessagesLossless(
	session: { addAssistantMessage(content: any[]): string; addUserMessage(content: any): string },
	messages: SessionMessage[],
): void {
	for (const msg of messages) {
		if (msg.role === "assistant") {
			session.addAssistantMessage(typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : (msg.content as any[]));
		} else {
			session.addUserMessage(msg.content);
		}
	}
}

/** Merge each run of consecutive user messages into one, tool results first.
 *  omp can put a reminder between two parallel tool results; left apart,
 *  repairToolPairing closes the tool_use set at the first user message and
 *  replaces the later real result with a synthetic "[no tool result recorded]". */
export function groupUserRuns(messages: SessionMessage[]): SessionMessage[] {
	const out: SessionMessage[] = [];
	let run: SessionMessage[] = [];
	const flush = () => {
		if (run.length === 1) out.push(run[0]);
		else if (run.length > 1) {
			const blocks = run.flatMap((m) => typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as any[]));
			const results = blocks.filter((b: any) => b.type === "tool_result");
			const rest = blocks.filter((b: any) => b.type !== "tool_result");
			out.push({ role: "user", content: [...results, ...rest] } as SessionMessage);
		}
		run = [];
	};
	for (const m of messages) {
		if (m.role === "user") run.push(m);
		else { flush(); out.push(m); }
	}
	flush();
	return out;
}

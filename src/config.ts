// User-facing extension config. Loaded once at extension registration from
// ~/.omp/agent/claude-bridge.json and the project OMP config directory, project
// overriding global. Missing or unparseable files are ignored (error to
// console.error, empty object returned) so the extension always starts.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { ContextWindowMode } from "./models.js";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
	/** Write ~/.omp/agent/claude-bridge.log like CLAUDE_BRIDGE_DEBUG=1 (read at load, from the global file only). */
	debug?: boolean;
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		appendSystemPrompt?: boolean;
		// Forward the host's (omp) own system prompt — tool inventory, todo/task
		// workflow, edit conventions — after Claude Code's preset. Default true:
		// without it Claude only knows Claude Code's native workflow.
		forwardHostPrompt?: boolean;
		// Which system prompt Claude Code runs with:
		//   "preset" (default) - Claude Code's own prompt, with the host prompt appended.
		//   "host"             - ONLY the host (omp) prompt + AGENTS.md + skills. One
		//                        coherent set of instructions, ~10k fewer cached tokens,
		//                        no guidance for Read/Edit/Bash tools that don't exist here.
		systemPrompt?: "preset" | "host";
		// Pre-spawn the next Claude Code process after each completed turn so the
		// next user message skips the ~1.7 s startup (SDK startup()). Default true.
		prewarm?: boolean;
		// Model for compaction / branch summaries (Claude Code model id, e.g.
		// "claude-sonnet-5"). Default "claude-sonnet-5": summaries don't need the
		// session's model, and Opus 5's safeguards sometimes refuse the
		// summarization prompt ("[reasoning_extraction]"). "current" keeps the
		// session's model. On a safeguard refusal the bridge retries once with
		// the next entry of compactFallbackModels.
		compactModel?: string;
		compactFallbackModels?: string[];
		// How much of the compaction-takeover budget to use before giving up and
		// letting omp compact its own way. omp aborts an extension handler at
		// 30 s, and a discarded takeover leaves the context uncompacted.
		compactDeadlineMs?: number;
		// Take over compaction summaries with an isolated Claude Code subprocess.
		// Default false: the takeover runs inside an extension handler the host
		// aborts at 30 s, too little for a real context, and a discarded takeover
		// leaves the session uncompacted. Left off, omp asks for the summary through
		// the normal provider path, which has no deadline. compactModel /
		// compactFallbackModels / compactDeadlineMs only apply when this is true.
		compactTakeover?: boolean;
		// Which historical thinking blocks to replay into the rebuilt Claude Code
		// session: "last" (default) only the final assistant turn, "all" every
		// one, "none" never. Replaying a long context's worth of reasoning back
		// to Opus 5 trips its safeguards ("[reasoning_extraction]") and costs
		// tokens; the API only needs them on the turn being continued.
		replayThinking?: "last" | "all" | "none";
		settingSources?: SettingSource[];
		strictMcpConfig?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		// Default window for unsuffixed model ids: "auto" follows per-model policy;
		// "1m" / "200k" prefer that window and fall back to the model's only window.
		// Explicit variant suffixes remain strict, independent of this preference.
		contextWindow?: ContextWindowMode;
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(join(homedir(), ".omp", "agent", "claude-bridge.json"));
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	return {
		askClaude: { ...global.askClaude, ...project.askClaude },
		provider: { ...global.provider, ...project.provider },
	};
}

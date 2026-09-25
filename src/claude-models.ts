// Model list straight from Claude Code.
//
// The static tables in models.ts only know the models this file's author had
// seen. Claude Code itself knows what the installed binary and the account's
// plan can serve: its /model picker. The SDK exposes that picker as
// `Query.supportedModels()`, a control request that needs a spawned process but
// no prompt — a never-yielding input generator keeps the process idle until we
// close it (~1.2 s, once, then cached by omp's model cache).
//
// Every picker entry resolves to a concrete model id (`resolvedModel`), often
// with a `[1m]` window hint; the same model can appear under several aliases
// ("default", "opus[1m]"). We collapse to base ids, remember which ones Claude
// Code offers at 1M, and let models.ts turn that into the 200K / 1M variants.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildVariantModels, MODEL_IDS_IN_ORDER, registerDynamicWindows, type LongContextSettings } from "./models.js";

const DISCOVERY_TIMEOUT_MS = 12_000;

export interface DiscoveredModel {
	id: string;          // base id, e.g. claude-fable-5-1
	name: string;        // Claude Code's display name, e.g. "Fable"
	description: string;
	oneM: boolean;       // Claude Code lists it with [1m]
	effortLevels: string[];
}

function baseModelId(resolved: string): string {
	return resolved.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
}

/** Pure: collapse Claude Code's picker entries into unique base models. */
export function collapsePickerModels(entries: Array<{ value: string; resolvedModel?: string; displayName: string; description: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }>): DiscoveredModel[] {
	const byId = new Map<string, DiscoveredModel>();
	for (const e of entries) {
		const resolved = e.resolvedModel ?? e.value;
		if (!/^claude-/i.test(resolved)) continue;
		const id = baseModelId(resolved);
		const oneM = /\[1m\]/i.test(resolved) || /\[1m\]/i.test(e.value);
		const prev = byId.get(id);
		// Prefer a real name over the "Default (recommended)" alias.
		if (!prev) {
			byId.set(id, { id, name: e.displayName, description: e.description, oneM, effortLevels: [...new Set(e.supportedEffortLevels ?? [])] });
		} else {
			prev.oneM = prev.oneM || oneM;
			// The default alias can omit capabilities that a named/window alias
			// supplies. Merge them all without retaining the SDK's mutable arrays.
			prev.effortLevels = [...new Set([...prev.effortLevels, ...(e.supportedEffortLevels ?? [])])];
			if (/^default/i.test(prev.name) && !/^default/i.test(e.displayName)) { prev.name = e.displayName; prev.description = e.description; }
		}
	}
	return [...byId.values()];
}

async function withTimeout<T>(ms: number, run: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Claude Code model discovery timed out after ${ms}ms`)), ms); });
	try { return await Promise.race([run(), timeout]); } finally { if (timer) clearTimeout(timer); }
}

/** Ask the installed Claude Code which models it offers. Throws on failure; the
 *  caller falls back to the static list. */
export async function fetchClaudeCodeModels(pathToClaudeCodeExecutable: string | undefined, log?: (msg: string) => void): Promise<DiscoveredModel[]> {
	async function* never(): AsyncGenerator<never> { await new Promise<never>(() => {}); }
	const q = query({
		prompt: never() as any,
		options: {
			tools: [],
			settingSources: [],
			permissionMode: "bypassPermissions",
			...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
		},
	});
	try {
		const entries = await withTimeout(DISCOVERY_TIMEOUT_MS, () => q.supportedModels());
		const models = collapsePickerModels(entries as any);
		log?.(`models: Claude Code lists ${entries.length} picker entries → ${models.map((m) => `${m.id}${m.oneM ? "[1m]" : ""}`).join(" ")}`);
		return models;
	} finally {
		try { q.close(); } catch { /* already gone */ }
	}
}

/** Turn discovered models into omp provider model configs (base + window
 *  variants), borrowing catalog metadata (thinking levels, input types, max
 *  output) from omp's own Anthropic entries when it has them. */
export function toProviderModels<T extends { id: string; name: string; reasoning?: boolean; input?: string[]; contextWindow?: number | null; maxTokens?: number; thinkingLevelMap?: unknown; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } }>(
	discovered: DiscoveredModel[],
	catalog: T[],
	settings: LongContextSettings,
): Array<Record<string, unknown>> {
	// Claude Code's picker order is the plan's own ranking; keep it.
	const base = discovered.map((d) => {
		registerDynamicWindows(d.id, { oneM: d.oneM });
		const cat = catalog.find((c) => c.id === d.id);
		return {
			id: d.id,
			name: cat?.name ?? `Claude ${d.name}`,
			reasoning: cat?.reasoning ?? d.effortLevels.length > 0,
			input: cat?.input ?? ["text", "image"],
			contextWindow: cat?.contextWindow ?? 200_000,
			maxTokens: cat?.maxTokens ?? 32_000,
			...(cat?.thinkingLevelMap ? { thinkingLevelMap: cat.thinkingLevelMap } : {}),
			cost: { ...(cat?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) },
		};
	});
	// Known ids get the measured window policy from models.ts; unknown ones the
	// generic policy registered above. Same variant expansion for both.
	const known = base.filter((m) => MODEL_IDS_IN_ORDER.includes(m.id));
	const unknown = base.filter((m) => !MODEL_IDS_IN_ORDER.includes(m.id));
	return buildVariantModels([...known, ...unknown], settings) as Array<Record<string, unknown>>;
}

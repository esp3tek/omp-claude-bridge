// Canonical selection + display order for the model picker.
// Exact ids win; family aliases such as `opus` use the first partial match.
// Extracted from index.ts so tests can import without activating the extension.

// Models learned at runtime from Claude Code's own picker (see claude-models.ts).
// Known ids in the tables below keep their measured policy; anything else that
// Claude Code lists gets a generic one: 200K default (no long-context
// surcharge), plus a "-1m" variant when Claude Code offers the model with [1m].
export const DYNAMIC_WINDOWS = new Map<string, { oneM: boolean }>();
export function registerDynamicWindows(id: string, caps: { oneM: boolean }): void {
	if (!MODEL_IDS_IN_ORDER.includes(id)) DYNAMIC_WINDOWS.set(id, caps);
}

// Registered when Claude Code's own list is not available yet (first launch
// before discovery, or discovery failing): the families the current Claude
// Code picker offers. Everything in MODEL_IDS_IN_ORDER keeps its window policy
// so it still works if discovery lists it or a role references it explicitly.
export const STATIC_FALLBACK_IDS = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];

export const MODEL_IDS_IN_ORDER = ["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];

// Workaround for models that ship without a thinkingLevelMap. Sonnet 5 and
// Sonnet 4.6 have no map, so getSupportedThinkingLevels hides xhigh (it's
// opt-in). Both models' top effort tier is "max" with no real xhigh (verified
// via Claude Code's supportedModels API), so xhigh->max matches opus-4-6.
const DEFAULT_THINKING_LEVEL_MAPS: Record<string, Record<string, string>> = {
	"claude-sonnet-5": { xhigh: "max" },
	"claude-sonnet-4-6": { xhigh: "max" },
};

// Project pi-ai's model entries down to the fields OMP's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
// Context-dependent display labels are applied after plan/long-context config is known.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[], ids: readonly string[] = MODEL_IDS_IN_ORDER) {
	return ids
		.map((id) => piAiModels.find((m) => m.id === id))
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh->xhigh instead of xhigh->max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap, cost }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens,
			thinkingLevelMap: thinkingLevelMap ?? DEFAULT_THINKING_LEVEL_MAPS[id],
			cost: { ...(cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) },
		}));
}

// User-selectable context-window policy (see provider.contextWindow in config).
//   "auto"  - per-model default policy (measured SDK behavior).
//   "1m"    - prefer 1M; a 200K-only model keeps its sole available window.
//   "200k"  - prefer 200K; a 1M-only model keeps its sole available window.
// Explicit variant suffixes are strict requests and never fall back.
export type ContextWindowMode = "auto" | "1m" | "200k";

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
	contextWindow: ContextWindowMode;
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// Measured Claude Agent SDK subscription/OAuth behavior. Do not infer this from
// pi-ai's advertised contextWindow: bare Opus 4.7 serves 1M, bare Opus 4.8 does
// not, bare Fable 5 serves 200K while claude-fable-5[1m] serves 1M, and [1m]
// entitlement differs by model. The default-window preference falls back to the
// other supported window, using the same policy for registration and execution.
export function resolveClaudeCodeRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel | null {
	switch (settings.contextWindow) {
		case "1m":
			return resolveForcedOneMRuntimeModel(modelId) ?? resolveForcedTwoHundredKRuntimeModel(modelId);
		case "200k":
			return resolveForcedTwoHundredKRuntimeModel(modelId) ?? resolveForcedOneMRuntimeModel(modelId);
		case "auto":
			return resolveAutoRuntimeModel(modelId, settings);
	}
}

function resolveAutoRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel {
	switch (modelId) {
		case "claude-opus-5-5":
			return { cliModelId: "claude-opus-5-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-5":
			return { cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-7":
			return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6": {
			const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
			return {
				cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
				contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		}
		case "claude-fable-5-1":
			return { cliModelId: "claude-fable-5-1", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-4-6":
			return {
				cliModelId: settings.longContextExtraUsage ? "claude-sonnet-4-6[1m]" : "claude-sonnet-4-6",
				contextWindow: settings.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		case "claude-haiku-4-5":
			return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			// Same reasoning as the forced-200K resolver: an id these tables do not
			// know is a newer model, and 200K is the safe default for it.
			return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
}

function resolveForcedOneMRuntimeModel(modelId: string): ClaudeCodeRuntimeModel | null {
	switch (modelId) {
		case "claude-opus-5-5":
			return { cliModelId: "claude-opus-5-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-5":
			return { cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-7":
			return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6":
			return { cliModelId: "claude-opus-4-6[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-fable-5-1":
			return { cliModelId: "claude-fable-5-1[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-4-6":
			return { cliModelId: "claude-sonnet-4-6[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-haiku-4-5":
			return null;
		default: {
			const dyn = DYNAMIC_WINDOWS.get(modelId);
			if (dyn) return dyn.oneM ? { cliModelId: `${modelId}[1m]`, contextWindow: ONE_M_CONTEXT } : null;
			// A "-1m" variant id only exists because discovery offered it; after a
			// restart omp serves that id from its model cache without re-running
			// discovery, so trust the id rather than hide the model.
			return { cliModelId: `${modelId}[1m]`, contextWindow: ONE_M_CONTEXT };
		}
	}
}

function resolveForcedTwoHundredKRuntimeModel(modelId: string): ClaudeCodeRuntimeModel | null {
	switch (modelId) {
		case "claude-opus-5-5":
			return { cliModelId: "claude-opus-5-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-opus-5":
			return { cliModelId: "claude-opus-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-opus-4-7":
			return null;
		case "claude-opus-4-6":
			return { cliModelId: "claude-opus-4-6", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-fable-5-1":
			return { cliModelId: "claude-fable-5-1", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-sonnet-4-6":
			return { cliModelId: "claude-sonnet-4-6", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-haiku-4-5":
			return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			// An unknown id is a model Claude Code offered that these tables predate.
			// The bare id IS the 200K request, so it always has a runtime — and the
			// id can reach us in a process that never ran discovery (the host caches
			// the model list for 24 h), where DYNAMIC_WINDOWS is empty. Hiding it
			// there dropped a freshly released model from a session that had just
			// listed it.
			return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
}

// Split a registered picker id into its base model id and the forced window it
// encodes. Variant ids carry a "-1m"/"-200k" suffix (see buildVariantModels); the
// unsuffixed id maps to the config default. Base ids never end in those suffixes,
// so the split is unambiguous.
export function parseVariantId(id: string): { baseId: string; forced?: "1m" | "200k" } {
	if (id.endsWith("-1m")) return { baseId: id.slice(0, -3), forced: "1m" };
	if (id.endsWith("-200k")) return { baseId: id.slice(0, -5), forced: "200k" };
	return { baseId: id };
}

export function claudeCodeModelId(model: { id: string; contextWindow?: number | null }, settings: LongContextSettings): string {
	const { baseId, forced } = parseVariantId(model.id);
	// omp restores discovered model entries from its cache without necessarily
	// rerunning discovery. For an unknown unsuffixed model, the cached window
	// preserves the capability fallback (e.g. a 200K-only model under "1m").
	// Known models and explicit suffixes still use their measured/strict policy.
	if (!forced && !MODEL_IDS_IN_ORDER.includes(baseId) && !DYNAMIC_WINDOWS.has(baseId)) {
		if (model.contextWindow === TWO_HUNDRED_K_CONTEXT) return baseId;
		if (model.contextWindow === ONE_M_CONTEXT) return `${baseId}[1m]`;
	}
	const runtimeModel = forced === "1m"
		? resolveForcedOneMRuntimeModel(baseId)
		: forced === "200k"
			? resolveForcedTwoHundredKRuntimeModel(baseId)
			: resolveClaudeCodeRuntimeModel(baseId, settings);
	if (runtimeModel == null) {
		const requested = forced ?? settings.contextWindow;
		throw new Error(`claude-bridge: model ${model.id} has no Claude Code runtime (contextWindow=${requested})`);
	}
	return runtimeModel.cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower) ?? models.find((m) => m.id.includes(lower));
}

function variantName(baseName: string, contextWindow: number): string {
	const label = contextWindow === ONE_M_CONTEXT ? "1M" : "200K";
	// Strip any window hint pi-ai already baked into the name so we don't double it.
	const base = baseName.replace(/\s*(?:\((?:1M|200K)\)|\b1M\b)\s*$/i, "").trimEnd();
	return `${base} (${label})`;
}

// Expand each model into one registered entry per context window it supports, so
// the user picks the window on demand from OMP's model picker. The unsuffixed id
// (e.g. claude-opus-4-8) maps to the config default window; every other available
// window gets a "-1m"/"-200k" suffixed id. Each entry's contextWindow must match
// the window the bridge actually requests (see claudeCodeModelId), or OMP's status
// bar and auto-compaction threshold will misreport. Both windows stay pickable
// regardless of provider.contextWindow, which only picks the default.
export function buildVariantModels<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	const result: T[] = [];
	for (const m of models) {
		// Unknown model (not in the model tables): keep one default-path entry.
		// Done before the forced-resolver probes below, which log "hiding it" on
		// unknown ids — misleading noise for a model we actually keep.
		if (!MODEL_IDS_IN_ORDER.includes(m.id) && !DYNAMIC_WINDOWS.has(m.id)) {
			const runtimeModel = resolveClaudeCodeRuntimeModel(m.id, settings);
			if (runtimeModel != null) result.push({ ...m, contextWindow: runtimeModel.contextWindow, name: variantName(m.name, runtimeModel.contextWindow) });
			continue;
		}

		// Known models always have at least one available window.
		const available: Array<{ kind: "1m" | "200k"; contextWindow: number }> = [];
		if (resolveForcedOneMRuntimeModel(m.id) != null) available.push({ kind: "1m", contextWindow: ONE_M_CONTEXT });
		if (resolveForcedTwoHundredKRuntimeModel(m.id) != null) available.push({ kind: "200k", contextWindow: TWO_HUNDRED_K_CONTEXT });

		// The config default decides which window is unsuffixed; fall back to the sole
		// available window when the preferred one has no runtime (e.g. Haiku under
		// "1m", Opus 4.7 under "200k").
		const defaultRuntime = resolveClaudeCodeRuntimeModel(m.id, settings);
		const preferredKind: "1m" | "200k" | undefined = defaultRuntime == null
			? undefined
			: defaultRuntime.contextWindow === ONE_M_CONTEXT ? "1m" : "200k";
		const defaultKind = preferredKind != null && available.some((a) => a.kind === preferredKind)
			? preferredKind
			: available[0].kind;

		const ordered = [
			...available.filter((a) => a.kind === defaultKind),
			...available.filter((a) => a.kind !== defaultKind),
		];
		for (const { kind, contextWindow } of ordered) {
			const id = kind === defaultKind ? m.id : `${m.id}-${kind}`;
			result.push({ ...m, id, contextWindow, name: variantName(m.name, contextWindow) });
		}
	}
	return result;
}

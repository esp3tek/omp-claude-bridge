import test from "node:test";
import assert from "node:assert/strict";

import { buildModels, buildVariantModels, claudeCodeModelId, parseVariantId, resolveModel, resolveClaudeCodeRuntimeModel, MODEL_IDS_IN_ORDER, registerDynamicWindows, DYNAMIC_WINDOWS } from "../src/models.ts";

// Minimal stand-ins for pi-ai model entries (buildVariantModels reads id, name,
// contextWindow and spreads the rest through to each variant).
const MODELS = [
	{ id: "claude-fable-5", name: "Fable 5", contextWindow: 1_000_000 },
	{ id: "claude-opus-4-8", name: "Opus 4.8", contextWindow: 200_000 },
	{ id: "claude-opus-4-7", name: "Opus 4.7", contextWindow: 1_000_000 },
	{ id: "claude-opus-4-6", name: "Opus 4.6", contextWindow: 200_000 },
	{ id: "claude-sonnet-5", name: "Sonnet 5", contextWindow: 200_000 },
	{ id: "claude-sonnet-4-6", name: "Sonnet 4.6", contextWindow: 200_000 },
	{ id: "claude-haiku-4-5", name: "Haiku 4.5", contextWindow: 200_000 },
];

const settings = (contextWindow, extra = {}) => ({ plan: "pro", longContextExtraUsage: false, contextWindow, ...extra });
const variants = (contextWindow, extra) => buildVariantModels(MODELS, settings(contextWindow, extra));
const byId = (contextWindow, extra) => Object.fromEntries(variants(contextWindow, extra).map((m) => [m.id, m]));

test("auto (Pro): each model expands to its available windows with correct ids, windows, and labels", () => {
	const m = byId("auto");
	// Opus 4.8: default 1M unsuffixed + 200K alternate.
	assert.equal(m["claude-opus-4-8"].contextWindow, 1_000_000);
	assert.equal(m["claude-opus-4-8"].name, "Opus 4.8 (1M)");
	assert.equal(m["claude-opus-4-8-200k"].contextWindow, 200_000);
	assert.equal(m["claude-opus-4-8-200k"].name, "Opus 4.8 (200K)");
	// Opus 4.7: 1M only, no 200K variant.
	assert.equal(m["claude-opus-4-7"].contextWindow, 1_000_000);
	assert.ok(!m["claude-opus-4-7-200k"], "opus-4-7 has no 200K runtime");
	// Opus 4.6 (Pro): default 200K unsuffixed + 1M alternate.
	assert.equal(m["claude-opus-4-6"].contextWindow, 200_000);
	assert.equal(m["claude-opus-4-6-1m"].contextWindow, 1_000_000);
	// Fable 5: default 200K + 1M alternate.
	assert.equal(m["claude-fable-5"].contextWindow, 200_000);
	assert.equal(m["claude-fable-5-1m"].contextWindow, 1_000_000);
	// Sonnet 5: default 1M + 200K alternate.
	assert.equal(m["claude-sonnet-5"].contextWindow, 1_000_000);
	assert.equal(m["claude-sonnet-5-200k"].contextWindow, 200_000);
	// Sonnet 4.6: default 200K + 1M alternate.
	assert.equal(m["claude-sonnet-4-6"].contextWindow, 200_000);
	assert.equal(m["claude-sonnet-4-6-1m"].contextWindow, 1_000_000);
	// Haiku 4.5: 200K only, no 1M variant.
	assert.equal(m["claude-haiku-4-5"].contextWindow, 200_000);
	assert.ok(!m["claude-haiku-4-5-1m"], "haiku has no 1M runtime");
});

test("auto (Pro): 12 entries, and no base model emits two entries for the same window", () => {
	const list = variants("auto");
	assert.equal(list.length, 12);
	for (const base of MODELS.map((mm) => mm.id)) {
		const windows = list.filter((v) => v.id === base || v.id.startsWith(`${base}-`)).map((v) => v.contextWindow);
		assert.equal(new Set(windows).size, windows.length, `${base} has duplicate windows`);
	}
});

test("the default variant is listed before its suffixed alternate", () => {
	const ids = variants("auto").map((m) => m.id);
	assert.ok(ids.indexOf("claude-opus-4-8") < ids.indexOf("claude-opus-4-8-200k"));
	assert.ok(ids.indexOf("claude-sonnet-5") < ids.indexOf("claude-sonnet-5-200k"));
	assert.ok(ids.indexOf("claude-fable-5") < ids.indexOf("claude-fable-5-1m"));
});

test("auto (Max): Opus 4.6 default flips to 1M and 200K becomes the suffixed alternate", () => {
	const m = byId("auto", { plan: "max" });
	assert.equal(m["claude-opus-4-6"].contextWindow, 1_000_000);
	assert.equal(m["claude-opus-4-6-200k"].contextWindow, 200_000);
	assert.ok(!m["claude-opus-4-6-1m"], "1M is the default (unsuffixed) under Max");
});

test("200k config: unsuffixed prefers 200K, 1M stays available as -1m, Opus 4.7 falls back to 1M", () => {
	const m = byId("200k");
	assert.equal(m["claude-opus-4-8"].contextWindow, 200_000);
	assert.equal(m["claude-opus-4-8-1m"].contextWindow, 1_000_000);
	assert.ok(!m["claude-opus-4-8-200k"], "200K is the default here, so no suffixed duplicate");
	// Opus 4.7 has no 200K runtime, so its only window (1M) becomes the unsuffixed default.
	assert.equal(m["claude-opus-4-7"].contextWindow, 1_000_000);
	assert.ok(!m["claude-opus-4-7-1m"]);
	assert.equal(m["claude-haiku-4-5"].contextWindow, 200_000);
});

test("1m config: unsuffixed prefers 1M, 200K stays available as -200k, Haiku falls back to 200K", () => {
	const m = byId("1m");
	assert.equal(m["claude-opus-4-8"].contextWindow, 1_000_000);
	assert.equal(m["claude-opus-4-8-200k"].contextWindow, 200_000);
	assert.ok(!m["claude-opus-4-8-1m"], "1M is the default here, so no suffixed duplicate");
	// Haiku has no 1M runtime, so 200K stays the unsuffixed default.
	assert.equal(m["claude-haiku-4-5"].contextWindow, 200_000);
	assert.ok(!m["claude-haiku-4-5-200k"]);
	assert.equal(m["claude-opus-4-7"].contextWindow, 1_000_000);
});

test("parseVariantId splits window suffixes and leaves base ids intact", () => {
	assert.deepEqual(parseVariantId("claude-opus-4-8"), { baseId: "claude-opus-4-8" });
	assert.deepEqual(parseVariantId("claude-opus-4-8-200k"), { baseId: "claude-opus-4-8", forced: "200k" });
	assert.deepEqual(parseVariantId("claude-fable-5-1m"), { baseId: "claude-fable-5", forced: "1m" });
});

test("claudeCodeModelId: unsuffixed id follows the config default", () => {
	assert.equal(claudeCodeModelId({ id: "claude-fable-5" }, settings("auto")), "claude-fable-5");
	assert.equal(claudeCodeModelId({ id: "claude-fable-5" }, settings("1m")), "claude-fable-5[1m]");
	assert.equal(claudeCodeModelId({ id: "claude-opus-4-8" }, settings("auto")), "claude-opus-4-8[1m]");
	assert.equal(claudeCodeModelId({ id: "claude-opus-4-8" }, settings("200k")), "claude-opus-4-8");
});

test("claudeCodeModelId: a suffixed id forces its window regardless of config", () => {
	assert.equal(claudeCodeModelId({ id: "claude-opus-4-8-200k" }, settings("auto")), "claude-opus-4-8");
	assert.equal(claudeCodeModelId({ id: "claude-opus-4-8-200k" }, settings("1m")), "claude-opus-4-8");
	assert.equal(claudeCodeModelId({ id: "claude-fable-5-1m" }, settings("200k")), "claude-fable-5[1m]");
	assert.equal(claudeCodeModelId({ id: "claude-opus-4-6-1m" }, settings("auto")), "claude-opus-4-6[1m]");
});

test("explicit unavailable window suffixes are rejected", () => {
	assert.throws(() => claudeCodeModelId({ id: "claude-haiku-4-5-1m" }, settings("auto")));
	assert.throws(() => claudeCodeModelId({ id: "claude-opus-4-7-200k" }, settings("auto")));
});

test("unsuffixed models use their sole available window when the preference is unavailable", () => {
	assert.equal(claudeCodeModelId({ id: "claude-haiku-4-5" }, settings("1m")), "claude-haiku-4-5");
	assert.equal(claudeCodeModelId({ id: "claude-opus-4-7" }, settings("200k")), "claude-opus-4-7");
});

test("exact model ids win over earlier partial matches without changing family aliases", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(id => ({ id, name: id })));
	for (const requested of MODEL_IDS_IN_ORDER) {
		assert.equal(resolveModel(models, requested)?.id, requested);
		assert.equal(resolveModel([...models].reverse(), requested.toUpperCase())?.id, requested);
	}
	assert.equal(resolveModel(models, "opus")?.id, "claude-opus-5-5");
	assert.equal(resolveModel(models, "fable")?.id, "claude-fable-5-1");
	assert.equal(resolveModel(models, "missing-model"), undefined);
});

// Exercise registration and execution together, rather than asserting conflicting
// behaviors for each helper independently. The tables include every known family.
for (const contextWindow of ["auto", "1m", "200k"]) {
	for (const plan of ["pro", "max"]) {
		for (const longContextExtraUsage of [false, true]) {
			test(`every picker entry runs at its advertised window (${contextWindow}, ${plan}, extra=${longContextExtraUsage})`, () => {
				const config = settings(contextWindow, { plan, longContextExtraUsage });
				const bases = MODEL_IDS_IN_ORDER.map(id => ({ id, name: id }));
				const list = buildVariantModels(bases, config);
				assert.equal(new Set(list.map(m => m.id)).size, list.length);
				for (const entry of list) {
					const runtimeId = claudeCodeModelId(entry, config);
					const base = parseVariantId(entry.id).baseId;
					const servedWindow = runtimeId.endsWith("[1m]") || base === "claude-opus-4-7" ? 1_000_000 : 200_000;
					assert.equal(entry.contextWindow, servedWindow, entry.id);
					assert.equal(runtimeId.replace(/\[1m\]$/, ""), base);
					assert.equal(resolveModel(list, entry.id)?.id, entry.id);
				}
				for (const base of bases) {
					const entry = list.find(m => m.id === base.id);
					assert.ok(entry, base.id);
					assert.equal(resolveClaudeCodeRuntimeModel(base.id, config)?.contextWindow, entry.contextWindow);
				}
			});
		}
	}
}

test("discovered single-window models also keep a runnable default under a 1M preference", () => {
	const id = "claude-window-regression";
	try {
		registerDynamicWindows(id, { oneM: false });
		const [entry] = buildVariantModels([{ id, name: id }], settings("1m"));
		assert.equal(entry.contextWindow, 200_000);
		assert.equal(claudeCodeModelId(entry, settings("1m")), id);
		assert.throws(() => claudeCodeModelId({ id: `${id}-1m` }, settings("1m")));
		// A new omp process restores the model entry without the discovery map.
		DYNAMIC_WINDOWS.delete(id);
		assert.equal(claudeCodeModelId(entry, settings("1m")), id);
	} finally {
		DYNAMIC_WINDOWS.delete(id);
	}
});

test("cached discovered variants preserve their advertised windows without rediscovery", () => {
	const id = "claude-cached-window-regression";
	for (const contextWindow of ["auto", "1m", "200k"]) {
		registerDynamicWindows(id, { oneM: true });
		const config = settings(contextWindow);
		const entries = buildVariantModels([{ id, name: id }], config);
		DYNAMIC_WINDOWS.delete(id);
		for (const entry of entries) {
			assert.equal(claudeCodeModelId(entry, config), entry.contextWindow === 1_000_000 ? `${id}[1m]` : id);
		}
	}
});

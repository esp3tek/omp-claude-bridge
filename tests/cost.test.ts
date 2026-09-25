import { expect, test } from "bun:test";
import { calculateUsageCost } from "../src/cost.ts";
import { buildModels, buildVariantModels } from "../src/models.ts";
import { toProviderModels } from "../src/claude-models.ts";

// Fixture rates; production always reads omp's catalog instead of hardcoding prices.
const rates = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const base = { id: "claude-opus-5-5", name: "Opus", cost: rates, contextWindow: 1_000_000 };
const tokens = { input: 1000, output: 200, cacheRead: 10000, cacheWrite: 2000 };
const settings = { contextWindow: "200k" as const, plan: "pro" as const, longContextExtraUsage: false };

test("cost total includes input, output, cache reads and cache writes", () => {
	const cost = calculateUsageCost(base, tokens);
	expect(cost).toMatchObject({ input: 0.004, output: 0.004, cacheRead: 0.002, cacheWrite: 0.01 });
	expect(cost.total).toBeCloseTo(0.02, 10);
});

test("cumulative usage updates recompute cost without adding the same tokens twice", () => {
	const first = calculateUsageCost(base, tokens);
	const last = calculateUsageCost(base, { ...tokens, output: 400 });
	expect(last.total).toBeCloseTo(first.total + 0.004, 10);
	expect(calculateUsageCost(base, { ...tokens, output: 400 }).total).toBe(last.total);
});

for (const id of [base.id, `${base.id}-1m`, `${base.id}-200k`]) {
	test(`an old zero-price cached model recovers catalog rates: ${id}`, () => {
		expect(calculateUsageCost({ id, cost: zero }, tokens, [base]).total).toBeCloseTo(0.02, 10);
	});
}

test("configured model rates take precedence over catalog fallback", () => {
	expect(calculateUsageCost({ ...base, cost: { ...rates, output: 40 } }, tokens, [base]).total).toBeCloseTo(0.024, 10);
});

test("missing or invalid pricing stays finite without inventing another model's rates", () => {
	expect(calculateUsageCost({ id: "unknown" }, tokens, [base]).total).toBe(0);
	expect(calculateUsageCost({ id: "invalid", cost: { ...rates, input: NaN, output: -1, cacheRead: Infinity } }, tokens).total).toBeCloseTo(0.01, 10);
});

test("static fallback registration preserves catalog prices for both window variants", () => {
	const models = buildVariantModels(buildModels([base], [base.id]), settings);
	expect(models.map(m => m.id)).toEqual([base.id, `${base.id}-1m`]);
	for (const model of models) expect(model.cost).toEqual(rates);
	expect(models[0].cost).not.toBe(base.cost);
});

test("discovered models preserve catalog rates and leave unknown prices unset as zero", () => {
	const discovered = [base.id, "claude-unknown"].map(id => ({ id, name: id, description: "", oneM: true, effortLevels: [] }));
	const models = toProviderModels(discovered, [base], settings);
	for (const model of models) expect(model.cost).toEqual(String(model.id).startsWith(base.id) ? rates : zero);
});

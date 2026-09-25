// API-equivalent estimates from omp's catalog, not subscription charges.
import { parseVariantId } from "./models.js";

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type PricedModel = { id: string; cost?: Partial<Rates> };
type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function calculateUsageCost(model: PricedModel, usage: Tokens, catalog: readonly PricedModel[] = []): Rates & { total: number } {
	const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
	const hasRates = keys.some((key) => Number.isFinite(model.cost?.[key]) && model.cost![key]! > 0);
	// omp can restore a model cached by older bridge versions with all-zero rates.
	// Resolve the base id at use time so a cached -1m/-200k variant also recovers.
	const rates = hasRates ? model.cost : catalog.find((entry) => entry.id === parseVariantId(model.id).baseId)?.cost;
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	for (const key of keys) {
		const rate = rates?.[key];
		cost[key] = typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? usage[key] * rate / 1_000_000 : 0;
		cost.total += cost[key];
	}
	return cost;
}

import { test, expect } from "bun:test";
import { collapsePickerModels, toProviderModels } from "../src/claude-models.ts";
import { DYNAMIC_WINDOWS } from "../src/models.ts";
const picker = [
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "Opus 5 with 1M context", supportedEffortLevels: ["low","high"] },
  { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)", description: "Opus 5 with 1M context" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5" },
];
test("collapses aliases, strips [1m] and date suffix, keeps 1M capability", () => {
  const m = collapsePickerModels(picker);
  expect(m.map((x) => x.id)).toEqual(["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5"]);
  expect(m.find((x) => x.id === "claude-opus-5")!.oneM).toBe(true);
  expect(m.find((x) => x.id === "claude-fable-5-1")!.oneM).toBe(true);
  expect(m.find((x) => x.id === "claude-sonnet-5")!.oneM).toBe(false);
  expect(m.find((x) => x.id === "claude-opus-5")!.name).toBe("Opus (1M context)");
});

const effortAliases = [
  { value: "default", resolvedModel: "claude-effort-regression", displayName: "Default", description: "" },
  { value: "opus", resolvedModel: "claude-effort-regression", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { value: "opus[1m]", resolvedModel: "claude-effort-regression[1m]", displayName: "Opus", description: "", supportedEffortLevels: ["high", "max"] },
];
for (const entries of [effortAliases, [...effortAliases].reverse(), [effortAliases[1], effortAliases[0], effortAliases[2]]]) {
  test(`aliases merge effort capabilities regardless of order (${entries.map(e => e.value).join(", ")})`, () => {
    const before = JSON.stringify(entries);
    const discovered = collapsePickerModels(entries);
    expect(discovered).toHaveLength(1);
    expect([...discovered[0].effortLevels].sort()).toEqual(["high", "low", "max", "medium"]);
    expect(discovered[0].oneM).toBe(true);
    expect(discovered[0].name).toBe("Opus");
    const registered = toProviderModels(discovered, [], { contextWindow: "auto", plan: "pro", longContextExtraUsage: false });
    expect(registered).toHaveLength(2);
    for (const model of registered) expect(model.reasoning).toBe(true);
    expect(JSON.stringify(entries)).toBe(before);
    DYNAMIC_WINDOWS.delete("claude-effort-regression");
  });
}

test("merged effort levels do not share an array with the original picker entries", () => {
  const entries = [{ ...effortAliases[1], supportedEffortLevels: ["high"] }];
  const [model] = collapsePickerModels(entries);
  model.effortLevels.push("max");
  expect(entries[0].supportedEffortLevels).toEqual(["high"]);
});

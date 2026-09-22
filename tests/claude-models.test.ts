import { test, expect } from "bun:test";
import { collapsePickerModels } from "../src/claude-models.ts";
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

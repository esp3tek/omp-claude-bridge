import { test, expect } from "bun:test";
import { packToolDescription, CC_MCP_DESCRIPTION_LIMIT } from "../src/tool-description.ts";
// Real omp tool descriptions, captured with CLAUDE_BRIDGE_DEBUG=1.
const tools = JSON.parse(require("fs").readFileSync(new URL("./fixtures-omp-tools.json", import.meta.url), "utf8")).tools;
for (const t of tools) {
  test(`${t.name} (${t.description.length} chars)`, () => {
    const out = packToolDescription(t.description)!;
    expect(out.length).toBeLessThanOrEqual(CC_MCP_DESCRIPTION_LIMIT);
    if (t.description.length <= CC_MCP_DESCRIPTION_LIMIT) { expect(out).toBe(t.description); return; }
    expect(out.startsWith("[Condensed")).toBe(true);
    if (/<example>/.test(t.description)) expect(out).toContain("<example>");
    if (/<critical>/.test(t.description)) expect(out).toContain("<critical>");
    console.log(`  ${t.name}: ${t.description.length} → ${out.length}, examples kept: ${(out.match(/<example>/g) ?? []).length}/${(t.description.match(/<example>/g) ?? []).length}`);
  });
}

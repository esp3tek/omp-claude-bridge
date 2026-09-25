import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fake-omp.mjs", import.meta.url));
for (const script of ["compact", "switch", "prewarm", "subagent"]) {
  const target = fileURLToPath(new URL(`../${script}-test.mjs`, import.meta.url));
  const scenarios = ["success", "crash", "early-exit", "spawn-error", "rpc-error", "wrong-answer", "assistant-error", "late-crash"];
  if (script === "compact") scenarios.push("compact-error");
  if (script === "switch") scenarios.push("switch-error");
  if (script === "subagent") scenarios.push("missing-tool");
  for (const scenario of scenarios) {
    test(`${script}: ${scenario}`, () => {
      const result = spawnSync(process.execPath, [fixture, target, scenario], { encoding: "utf8", timeout: 10000 });
      assert.ifError(result.error);
      assert.equal(result.status, scenario === "success" ? 0 : 1, result.stdout + result.stderr);
    });
  }
}

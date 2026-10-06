import { test, expect } from "bun:test";
import { spawnClaudeCodeSafely, withSafeSpawn } from "../src/safe-spawn.ts";

const exitAtOnce = () => ({
  command: process.execPath,
  args: ["-e", "process.exit(0)"],
  env: { ...process.env },
  signal: new AbortController().signal,
});

test("writing while the child dies does not raise an uncaught EPIPE", async () => {
  const logs: string[] = [];
  const child = spawnClaudeCodeSafely(
    { ...exitAtOnce(), args: ["-e", "setTimeout(() => process.exit(0), 150)"] },
    undefined,
    (m) => logs.push(m),
  );
  // Same as the SDK: keep writing without a callback and without listening
  // for errors. Without the listener this exact loop dies with
  // "EPIPE: broken pipe, write" as an uncaught exception.
  const chunk = "x".repeat(16 * 1024);
  for (let i = 0; i < 60; i++) {
    try { child.stdin.write(chunk); } catch { /* sync failure after close is the SDK's to handle */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(logs.some((m) => m.includes("stdin error") && m.includes("EPIPE"))).toBe(true);
});

test("stderr from the child reaches the query's stderr callback", async () => {
  let seen = "";
  const child = spawnClaudeCodeSafely(
    { ...exitAtOnce(), args: ["-e", "process.stderr.write('hola'); process.exit(0)"] },
    (d) => { seen += d; },
  );
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise((r) => setTimeout(r, 100));
  expect(seen).toContain("hola");
});

test("withSafeSpawn keeps the options and adds the spawner", () => {
  const opts = withSafeSpawn({ cwd: "x", tools: [] });
  expect(opts.cwd).toBe("x");
  expect(typeof opts.spawnClaudeCodeProcess).toBe("function");
});

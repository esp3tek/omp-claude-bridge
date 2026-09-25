// Run from any directory. The plugin clone owns its sources and fixtures.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = resolve(process.argv[2] ?? process.env.OMP_BRIDGE_SOURCE ?? join(homedir(), ".omp", "local", "omp-claude-bridge"));
for (const file of ["package.json", "src/index.ts", "tests/fixtures-omp-tools.json"]) {
  if (!existsSync(join(bridge, file))) {
    console.error(`Missing ${join(bridge, file)}. Supply the plugin development clone: node tests/run-unit.mjs <path>.`);
    process.exit(1);
  }
}
const version = JSON.parse(readFileSync(join(bridge, "package.json"), "utf8")).version;
console.log(`Plugin ${version}: ${bridge}`);
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
const local = join(root, "tests", "regression");
run(process.execPath, ["--test", ...readdirSync(local).filter(f => f.endsWith(".test.mjs")).map(f => join(local, f))], root);
const files = readdirSync(join(bridge, "tests"));
const bunFiles = files.filter(f => f.endsWith(".test.ts")).map(f => `./tests/${f}`);
const nodeFiles = files.filter(f => /^unit-.*\.mjs$/.test(f)).map(f => `./tests/${f}`);
if (!bunFiles.length || !nodeFiles.length) {
  console.error("The plugin clone is missing its unit test suites.");
  process.exit(1);
}
run("bun", ["test", ...bunFiles], bridge);
// Node 24 can load the TypeScript imported by these tests without tsx.
run(process.execPath, ["--test", ...nodeFiles], bridge);

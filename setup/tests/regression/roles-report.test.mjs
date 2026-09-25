import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Mock the filesystem in a separate process; no access to real session contents.
function report(args) {
  const target = new URL("../../roles-report.ts", import.meta.url).href;
  const script = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';
    const require = createRequire(import.meta.url);
    const fs = require('node:fs'), os = require('node:os');
    const root = path.join(os.tmpdir(), 'omp-review-virtual-home');
    const dir = path.join(root, '.omp', 'agent', 'sessions');
    const file = path.join(dir, 'fixture.jsonl');
    const old = Date.now() - 10 * 86400000, now = Date.now();
    const msg = (timestamp, input) => ({type:'message', message:{role:'assistant',provider:'fixture',model:'test',timestamp,usage:{input,output:1}}});
    const usage = (timestamp, input) => ({type:'model_usage',timestamp:new Date(timestamp).toISOString(),role:'judge',purpose:'test',provider:'fixture',model:'test',usage:{input,output:1}});
    const fixture = [
      {type:'session'},
      {type:'model_change',timestamp:new Date(old).toISOString(),role:'plan',resolvedModelIsFallback:true},
      msg(old,1000), msg(now,10), usage(old,2000), usage(now,20),
      msg(undefined,3000), msg('invalid',4000)
    ].map(JSON.stringify).join('\\n');
    os.homedir = () => root;
    const read = fs.readFileSync, readdir = fs.readdirSync, stat = fs.statSync;
    fs.readdirSync = (p,...a) => p===dir ? ['fixture.jsonl'] : readdir(p,...a);
    fs.statSync = (p,...a) => p===file ? {isDirectory:()=>false,mtimeMs:now} : stat(p,...a);
    fs.readFileSync = (p,...a) => p===file ? fixture : read(p,...a);
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'roles-report.ts', ...${JSON.stringify(args)}];
    await import(${JSON.stringify(target)});
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
}
test("--days filters assistant and background usage, retaining earlier role/fallback state", () => {
  const result = report(["--days", "1", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const { roleTotals } = JSON.parse(result.stdout);
  assert.equal(roleTotals.plan.requests, 1);
  assert.equal(roleTotals.plan.input, 10);
  assert.equal(roleTotals.plan.fallback, 1);
  assert.equal(roleTotals['judge (test)'].requests, 1);
  assert.equal(roleTotals['judge (test)'].input, 20);
});
test("unbounded reports retain all historical usage", () => {
  const result = report(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const { roleTotals } = JSON.parse(result.stdout);
  assert.equal(roleTotals.plan.requests, 4);
  assert.equal(roleTotals.plan.input, 8010);
  assert.equal(roleTotals['judge (test)'].input, 2020);
});
for (const args of [["--days"], ["--days", "oops"], ["--days", "-1"], ["--days", "0"]]) {
  test(`reject invalid arguments ${args.join(' ')}`, () => {
    const result = report(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--days/);
  });
}

import { spawn } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);
const cwd = require("node:path").join(process.env.TEMP, "bridge-smoke");
const model = process.argv[2] ?? "claude-bridge/claude-haiku-4-5";
const child = spawn("omp", ["--mode", "rpc", "--no-session", "--auto-approve", "--model", model, "--cwd", cwd], { stdio: ["pipe", "pipe", "pipe"], shell: true, env: { ...process.env, CLAUDE_BRIDGE_DEBUG: "1" } });
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d)); const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
let buf = ""; let turn = 0; let sentAt = 0; let firstAt = 0; const times = [];
const t0 = Date.now(); const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const prompts = ["Responde solo OK.", "Responde solo OK2.", "Responde solo OK3."];
const next = () => { if (turn >= prompts.length) { child.stdin.end(); return; } sentAt = Date.now(); firstAt = 0; send({ id: "p" + turn, type: "prompt", message: prompts[turn] }); };
child.stdout.on("data", (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "ready") next();
    else if (o.type === "message_update" && !firstAt && o.message?.role === "assistant") { firstAt = Date.now(); }
    else if (o.type === "agent_end") { const total = Date.now() - sentAt; times.push({ turn, ttft: firstAt ? firstAt - sentAt : null, total }); log(`turn ${turn}: first token ${firstAt ? firstAt - sentAt : "?"} ms, total ${total} ms`); turn++; setTimeout(next, 4000); }
  }
});
setTimeout(() => { log("timeout"); child.kill(); process.exit(2); }, 120000);
child.on("exit", () => { console.log(JSON.stringify(times)); process.exit(0); });

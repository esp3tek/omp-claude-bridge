import { spawn } from "node:child_process";
import { smokeGuard } from "./smoke-guard.mjs";
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);
const cwd = require("node:path").join(process.env.TEMP, "bridge-smoke");
const model = process.argv[2] ?? "claude-bridge/claude-haiku-4-5";
const child = spawn("omp", ["--mode", "rpc", "--no-session", "--auto-approve", "--model", model, "--cwd", cwd], { stdio: ["pipe", "pipe", "pipe"], shell: true, env: { ...process.env, CLAUDE_BRIDGE_DEBUG: "1" } });
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
let buf = ""; let turn = 0; let sentAt = 0; let firstAt = 0; const times = [];
const t0 = Date.now(); const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const prompts = ["Palabra clave: KIWI. Responde solo OK.", "Responde solo OK2.", "¿Cuál era la palabra clave? Solo la palabra."];
const models = [null, {provider:"openai-codex", modelId:"gpt-5.6-luna"}, {provider:"claude-bridge", modelId:"claude-haiku-4-5"}];
let finalText = "", switches = 0, pendingModel;
const guard = smokeGuard(child, () => {
  console.log(JSON.stringify(times));
  return turn !== prompts.length ? "scenario incomplete" : switches !== 2 ? "model switches not acknowledged" : !/^KIWI[.!]?$/i.test(finalText.trim()) ? "keyword lost after model switch" : null;
}, 120000);
const prompt = () => { sentAt = Date.now(); firstAt = 0; send({ id: "p" + turn, type: "prompt", message: prompts[turn] }); };
const next = () => {
  if (turn >= prompts.length) { child.stdin.end(); return; }
  if (models[turn]) { pendingModel = "m" + turn; send({ id: pendingModel, type: "set_model", ...models[turn] }); }
  else prompt();
};
child.stdout.on("data", (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!guard.observe(o)) continue;
    if (o.type === "ready") next();
    else if (o.type === "response" && o.command === "set_model" && o.id === pendingModel && o.success) { pendingModel = undefined; switches++; prompt(); }
    else if (o.type === "message_update" && !firstAt && o.message?.role === "assistant") { firstAt = Date.now(); }
    else if (o.type === "message_end" && o.message?.role === "assistant") { const t=(o.message.content||[]).filter(b=>b.type==="text").map(b=>b.text).join(""); if (turn === 2) finalText = t; if (t) log("  answer: " + JSON.stringify(t.slice(0,80))); }
    else if (o.type === "agent_end") { const total = Date.now() - sentAt; times.push({ turn, ttft: firstAt ? firstAt - sentAt : null, total }); log(`turn ${turn}: first token ${firstAt ? firstAt - sentAt : "?"} ms, total ${total} ms`); turn++; setTimeout(next, 4000); }
  }
});

import { spawn } from "node:child_process";
import { join } from "node:path";
import { smokeGuard } from "./smoke-guard.mjs";
const model = process.argv[2] ?? "claude-bridge/claude-haiku-4-5";
const child = spawn("omp", ["--mode", "rpc", "--no-session", "--auto-approve", "--model", model, "--cwd", join(process.env.TEMP, "bridge-smoke")], { stdio: ["pipe", "pipe", "pipe"], shell: true, env: { ...process.env, CLAUDE_BRIDGE_DEBUG: "1" } });
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
let buf = ""; let step = 0; const t0 = Date.now(); const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
let completed = false, compacted = false, finalText = "";
const guard = smokeGuard(child, () => !completed ? "scenario incomplete" : !compacted ? "compact not acknowledged" : !/^MANDARINA[.!]?$/i.test(finalText.trim()) ? "keyword lost after compact" : null, 180000);
const steps = [
  () => send({ id: "p0", type: "prompt", message: "Palabra clave: MANDARINA. Lee high.yml y med.yml con read y resume cada uno en una frase." }),
  () => send({ id: "c", type: "compact" }),
  () => send({ id: "p1", type: "prompt", message: "Sin herramientas: ¿cuál era la palabra clave? Solo la palabra." }),
];
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let o; try { o = JSON.parse(l); } catch { continue; }
  if (!guard.observe(o)) continue;
  if (o.type === "ready") { steps[step++](); }
  else if (o.type === "response") { log(`response ${o.command} ok=${o.success}`); if (o.command === "compact" && o.id === "c" && o.success && !compacted) { compacted = true; setTimeout(() => steps[step++](), 1500); } }
  else if (o.type === "message_end" && o.message?.role === "assistant") { const t = (o.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""); if (step === 3) finalText = t; if (t) log("  answer: " + JSON.stringify(t.slice(0, 100))); }
  else if (o.type === "agent_end") { if (step === 1) setTimeout(() => steps[step++](), 1000); else if (step === 3) { completed = true; child.stdin.end(); } }
  else if (/compact/i.test(o.type)) log(`event ${o.type} ${JSON.stringify(o).slice(0, 160)}`);
} });

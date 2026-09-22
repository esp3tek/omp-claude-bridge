import { spawn } from "node:child_process";
import { join } from "node:path";
const child = spawn("omp", ["--mode", "rpc", "--no-session", "--cwd", join(process.env.TEMP, "bridge-smoke")], { stdio: ["pipe", "pipe", "pipe"], shell: true, env: { ...process.env, CLAUDE_BRIDGE_DEBUG: "1" } });
let buf = "";
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let o; try { o = JSON.parse(l); } catch { continue; }
  if (o.type === "ready") setTimeout(() => child.stdin.write(JSON.stringify({ id: "m", type: "get_available_models" }) + "\n"), 6000);
  if (o.type === "response" && o.command === "get_available_models") { const ms = (o.data?.models ?? o.models ?? []).filter((m) => m.provider === "claude-bridge"); console.log(ms.length + " claude-bridge models in session:"); ms.forEach((m) => console.log("  " + m.id + " | " + (m.name ?? "") + " | " + m.contextWindow)); child.stdin.end(); } } });
setTimeout(() => { console.log("timeout"); child.kill(); process.exit(2); }, 40000);
child.on("exit", () => process.exit(0));

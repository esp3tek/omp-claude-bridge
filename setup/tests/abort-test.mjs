// Mid-turn steer test through omp's RPC mode: start a slow tool, steer while it
// runs, check the model's final answer used the steer.
import { spawn } from "node:child_process";

const cwd = process.env.TEMP + "\\bridge-smoke";
const model = process.argv[2] ?? "claude-bridge/claude-haiku-4-5";
const child = spawn("omp", ["--mode", "rpc", "--no-session", "--auto-approve", "--model", model, "--cwd", cwd], {
	stdio: ["pipe", "pipe", "pipe"], shell: true, env: { ...process.env, CLAUDE_BRIDGE_DEBUG: "1" },
});
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
globalThis.ends = 0; let buf = ""; let text = ""; let steered = false; let done = false;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
child.stderr.on("data", () => {});
child.stdout.on("data", (d) => {
	buf += d.toString();
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let o; try { o = JSON.parse(line); } catch { continue; }
		if (o.type === "ready") {
			log("ready → prompt");
			send({ id: "p1", type: "prompt", message: "Ejecuta EXACTAMENTE este comando con la herramienta bash: sleep 15 && echo listo. Cuando termine, responde SOLO con la palabra clave que te haya dado el usuario; si no te ha dado ninguna, responde NINGUNA." });
		} else if (o.type === "response") {
			log(`response ${o.command} ok=${o.success}${o.error ? " err=" + o.error : ""}`);
		} else if (o.type === "tool_execution_start" || o.type === "tool_start" || (o.type === "event" && /tool.*start/.test(o.event?.type ?? ""))) {
			if (!steered) { steered = true; setTimeout(() => { log("tool running → abort"); send({ id: "a1", type: "abort" }); setTimeout(() => { log("after abort → new prompt"); send({ id: "p2", type: "prompt", message: "Sin herramientas: responde SOLO la palabra GRANADA." }); }, 2500); }, 3000); }
		} else if (o.type === "message_update" || o.type === "message_end" || o.type === "agent_end" || o.type === "turn_end") {
			const m = o.message ?? o;
			const parts = (m?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
			if (parts) text = parts;
			if (o.type === "agent_end" && ++globalThis.ends === 2) { done = true; log(`agent_end → final text: ${JSON.stringify(text.slice(0, 200))}`); child.stdin.end(); }
		} else if (!steered && /tool/i.test(o.type)) {
			// unknown tool event shape: still schedule the steer
			steered = true; setTimeout(() => { log(`(${o.type}) tool running → abort`); send({ id: "a1", type: "abort" }); setTimeout(() => { log("after abort → new prompt"); send({ id: "p2", type: "prompt", message: "Sin herramientas: responde SOLO la palabra GRANADA." }); }, 2500); }, 3000);
		}
	}
});
// fallback: steer 6s after prompt even if no tool event was recognised
setTimeout(() => { if (!steered) { steered = true; log("no tool event → abort anyway"); send({ id: "a1", type: "abort" }); setTimeout(() => { log("after abort → new prompt"); send({ id: "p2", type: "prompt", message: "Sin herramientas: responde SOLO la palabra GRANADA." }); }, 2500); } }, 8000);
setTimeout(() => { if (!done) { log("timeout"); child.kill(); process.exit(2); } }, 120000);
child.on("exit", (c) => { log(`omp exited ${c}; GRANADA in answer: ${/GRANADA/i.test(text)}`); process.exit(/GRANADA/i.test(text) ? 0 : 1); });

#!/usr/bin/env node
// Eficiencia del claude-bridge: lee los .jsonl que Claude Code escribe en
// ~/.claude/projects/<proyecto>/ y agrega el `usage` de cada respuesta.
//
//   node bridge-stats.mjs [--project <substr>] [--since YYYY-MM-DD] [--days N]
//
// Métricas por sesión y total:
//   turnos        respuestas del modelo (cada llamada a la API)
//   cacheRead     tokens servidos desde caché (baratos: 10 % del precio)
//   cacheWrite    tokens escritos en caché (caros: 125 % / 200 % con TTL 1h)
//   input         tokens sin caché (precio completo)
//   hit%          cacheRead / (cacheRead + cacheWrite + input)  → objetivo > 85 %
//   frías         llamadas con cacheWrite > 100k = reconstrucción de sesión o caché expirada
//   ctx medio     contexto medio por llamada (cacheRead + cacheWrite + input)
//   coste eq.     tokens "equivalentes a input" = input + write*1.25 + read*0.1 (proxy de cuota)
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const projectFilter = opt("--project", "");
const days = Number(opt("--days", "1"));
const since = opt("--since") ? new Date(opt("--since")) : new Date(Date.now() - days * 86400e3);

const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const rows = [];
for (const proj of readdirSync(root)) {
	if (projectFilter && !proj.toLowerCase().includes(projectFilter.toLowerCase())) continue;
	const dir = join(root, proj);
	let files;
	try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
	for (const f of files) {
		const p = join(dir, f);
		if (statSync(p).mtime < since) continue;
		const s = { proj, file: f.slice(0, 8), turns: 0, read: 0, write: 0, input: 0, output: 0, cold: 0, ctxSum: 0, models: new Set(), synthetic: false, first: null, last: null };
		for (const line of readFileSync(p, "utf8").split("\n")) {
			if (!line) continue;
			let o; try { o = JSON.parse(line); } catch { continue; }
			if (o.message?.id?.startsWith?.("msg_syn_")) s.synthetic = true;
			if (o.type !== "assistant" || !o.message?.usage) continue;
			const ts = o.timestamp ? new Date(o.timestamp) : null;
			if (ts && ts < since) continue;
			const u = o.message.usage;
			const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0, inp = u.input_tokens ?? 0, out = u.output_tokens ?? 0;
			if (read + write + inp === 0) continue;
			// CC escribe un registro por bloque de contenido con el mismo usage; contar una vez por message.id
			if (s.lastId === o.message.id) { s.output = s.output - s.lastOut + out; s.lastOut = out; continue; }
			s.lastId = o.message.id; s.lastOut = out;
			s.turns++; s.read += read; s.write += write; s.input += inp; s.output += out;
			s.ctxSum += read + write + inp;
			if (write > 100_000) s.cold++;
			if (o.message.model) s.models.add(o.message.model);
			if (ts) { s.first ??= ts; s.last = ts; }
		}
		if (s.turns) rows.push(s);
	}
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
const hit = (s) => s.read + s.write + s.input ? Math.round(100 * s.read / (s.read + s.write + s.input)) : 0;
const eq = (s) => s.input + s.write * 1.25 + s.read * 0.1;
rows.sort((a, b) => (a.first ?? 0) - (b.first ?? 0));

console.log(`Desde ${since.toISOString().slice(0, 16)}  proyectos: ${projectFilter || "todos"}\n`);
console.log("sesión    proyecto                         turnos  ctx medio  hit%  frías  cacheWrite  coste eq.  bridge  modelo");
const tot = { turns: 0, read: 0, write: 0, input: 0, output: 0, cold: 0, ctxSum: 0 };
for (const s of rows) {
	for (const k of Object.keys(tot)) tot[k] += s[k];
	console.log(
		s.file.padEnd(9), s.proj.replace(/^C--Users-YuriVidal-/, "").slice(0, 32).padEnd(33),
		String(s.turns).padStart(6), fmt(s.ctxSum / s.turns).padStart(10), String(hit(s)).padStart(5), String(s.cold).padStart(6),
		fmt(s.write).padStart(11), fmt(eq(s)).padStart(10), (s.synthetic ? "sí" : "no").padStart(7), " ", [...s.models].join(",").replace(/claude-/g, ""),
	);
}
console.log("\nTOTAL", `turnos=${tot.turns}`, `ctx medio=${fmt(tot.turns ? tot.ctxSum / tot.turns : 0)}`, `hit=${hit(tot)}%`, `frías=${tot.cold}`,
	`cacheRead=${fmt(tot.read)}`, `cacheWrite=${fmt(tot.write)}`, `input=${fmt(tot.input)}`, `output=${fmt(tot.output)}`, `coste eq.=${fmt(eq(tot))}`);
console.log("\nLectura: hit% > 85 y frías ≈ 1 por sesión = bien. Cada 'fría' recachea todo el contexto (cacheWrite ≈ ctx). 'bridge=sí' = sesión reconstruida por el bridge (ids msg_syn_).");

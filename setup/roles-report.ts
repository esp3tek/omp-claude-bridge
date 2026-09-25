// Informe de uso de omp por ROL (no solo por modelo).
// Lee ~/.omp/agent/sessions/**/*.jsonl y atribuye cada petición al rol activo:
//   - sesión principal: rol del último `model_change` con `role` (por defecto "default")
//   - subagentes (sesiones con parentSession): rol "task", o el `modelRole` que el
//     padre registró al lanzarlos (p. ej. PLAN_CRITICAL desde un agente personalizado)
//   - `model_usage`: tareas de fondo (judge/auto-thinking, title, memory, commit…)
// Uso: bun roles-report.ts [--days N] [--json]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const daysArg = args.indexOf("--days");
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : Infinity;
if (daysArg >= 0 && (!Number.isFinite(days) || days <= 0)) {
	console.error("--days requiere un número positivo de días.");
	process.exit(1);
}
const asJson = args.includes("--json");
const since = Number.isFinite(days) ? Date.now() - days * 86_400_000 : 0;

const root = join(homedir(), ".omp", "agent", "sessions");

function inPeriod(entry: any): boolean {
	if (daysArg < 0) return true;
	const value = entry.timestamp ?? entry.message?.timestamp;
	const timestamp = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(timestamp) && timestamp >= since;
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else if (name.endsWith(".jsonl") && st.mtimeMs >= since) out.push(p);
	}
	return out;
}

type Row = { requests: number; input: number; output: number; cacheRead: number; cost: number; fallback: number };
const rows = new Map<string, Row>(); // key: role \t provider/model
const roleTotals = new Map<string, Row>();

function bump(role: string, model: string, usage: any, isFallback: boolean) {
	const key = `${role}\t${model}`;
	const add = (r: Row) => {
		r.requests++;
		r.input += usage?.input ?? 0;
		r.output += usage?.output ?? 0;
		r.cacheRead += usage?.cacheRead ?? 0;
		r.cost += usage?.cost?.total ?? 0;
		if (isFallback) r.fallback++;
	};
	if (!rows.has(key)) rows.set(key, { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0, fallback: 0 });
	if (!roleTotals.has(role)) roleTotals.set(role, { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0, fallback: 0 });
	add(rows.get(key)!);
	add(roleTotals.get(role)!);
}

// Primera pasada: qué rol asignó cada sesión padre a cada subagente lanzado.
const spawnedRole = new Map<string, string>(); // `${parentFile}|${agentName}` -> role
const files = walk(root);
const parsed = new Map<string, any[]>();
for (const f of files) {
	const entries: any[] = [];
	for (const line of readFileSync(f, "utf8").split("\n")) {
		if (!line) continue;
		try { entries.push(JSON.parse(line)); } catch { /* línea corrupta */ }
	}
	parsed.set(f, entries);
	for (const e of entries) {
		if (e.type !== "message" || e.message?.role !== "toolResult" || e.message?.toolName !== "task") continue;
		const raw = JSON.stringify(e);
		const role = raw.match(/"modelRole":"([^"]+)"/)?.[1];
		if (!role) continue;
		for (const m of raw.matchAll(/Spawned agent `([^`]+)`/g)) spawnedRole.set(`${f}|${m[1]}`, role);
	}
}

for (const [f, entries] of parsed) {
	const header = entries.find((e) => e.type === "session");
	const parent = header?.parentSession as string | undefined;
	let role = "default";
	let isFallback = false;
	if (parent) {
		const agentName = basename(f, ".jsonl");
		role = spawnedRole.get(`${parent}|${agentName}`) ?? "task";
	}
	for (const e of entries) {
		if (e.type === "model_change") {
			if (e.role) role = e.role;
			isFallback = e.resolvedModelIsFallback === true;
			continue;
		}
		if (e.type === "model_usage") {
			if (inPeriod(e)) bump(`${e.role ?? "?"} (${e.purpose ?? "?"})`, `${e.provider}/${e.model}`, e.usage, false);
			continue;
		}
		if (e.type === "message" && e.message?.role === "assistant" && e.message?.model && inPeriod(e)) {
			bump(role, `${e.message.provider}/${e.message.model}`, e.message.usage, isFallback);
		}
	}
}

const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n);
const out = [...rows.entries()]
	.map(([k, r]) => { const [role, model] = k.split("\t"); return { role, model, ...r }; })
	.sort((a, b) => a.role.localeCompare(b.role) || b.requests - a.requests);

if (asJson) {
	console.log(JSON.stringify({ files: files.length, rows: out, roleTotals: Object.fromEntries(roleTotals) }, null, 2));
} else {
	console.log(`Sesiones leídas: ${files.length}${Number.isFinite(days) ? ` (últimos ${days} días)` : ""}\n`);
	const w = [22, 40, 8, 8, 8, 9, 8, 8];
	const line = (c: (string | number)[]) => c.map((v, i) => String(v).padEnd(w[i])).join(" ");
	console.log(line(["ROL", "MODELO", "REQS", "IN", "OUT", "CACHE", "COSTE$", "FALLBK"]));
	console.log("-".repeat(w.reduce((a, b) => a + b + 1, 0)));
	for (const r of out) console.log(line([r.role, r.model, r.requests, fmt(r.input), fmt(r.output), fmt(r.cacheRead), r.cost.toFixed(3), r.fallback]));
	console.log("\nTotales por rol:");
	for (const [role, r] of [...roleTotals.entries()].sort((a, b) => b[1].requests - a[1].requests))
		console.log(`  ${role.padEnd(24)} ${String(r.requests).padStart(5)} reqs  ${fmt(r.output).padStart(6)} out  $${r.cost.toFixed(3)}`);
	const configured = ["default", "slow", "plan", "PLAN_CRITICAL", "advisor", "task", "vision", "memory", "smol", "tiny", "commit"];
	const unused = configured.filter((c) => ![...roleTotals.keys()].some((k) => k === c || k.startsWith(`${c} (`)));
	if (unused.length) console.log(`\nRoles configurados sin uso registrado: ${unused.join(", ")}`);
}

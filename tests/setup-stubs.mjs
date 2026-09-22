// The extension's host packages (@oh-my-pi/*, the Claude Agent SDK) are peer
// dependencies omp provides at runtime, so they are not installed here and the
// unit tests cannot import src/ without them. This writes inert stubs into
// node_modules for every host import found in src/, leaving anything already
// installed untouched.
//
//   node tests/setup-stubs.mjs && bun test tests/*.test.ts
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const modulesDir = join(root, "node_modules");

const STUB = `const P = new Proxy(function () {}, {
	get: (_t, k) => (k === "__esModule" ? true : k === "then" ? undefined : P),
	apply: () => P,
	construct: () => P,
});
export default P;
export const StringEnum = P, Type = P, getModels = P, keyHint = P, buildSessionContext = P,
	compact = P, createSdkMcpServer = P, query = P, startup = P, Text = P, CONFIG_DIR_NAME = "agent";
`;

const imports = new Set();
for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
	const source = readFileSync(join(srcDir, file), "utf8");
	for (const m of source.matchAll(/from "(@oh-my-pi\/[^"]+|@anthropic-ai\/[^"]+)"/g)) imports.add(m[1]);
}

let written = 0;
for (const name of imports) {
	const dir = join(modulesDir, ...name.split("/"));
	// A bare package directory can exist only because a subpath stub created it;
	// what matters is whether this exact specifier resolves.
	if (existsSync(join(dir, "package.json"))) continue;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, main: "index.js", type: "module" }) + "\n");
	writeFileSync(join(dir, "index.js"), STUB);
	written++;
}
console.log(`host stubs: ${written} written, ${imports.size - written} already present`);

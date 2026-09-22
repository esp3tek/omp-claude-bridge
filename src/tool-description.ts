// Claude Code renders at most CC_MCP_DESCRIPTION_LIMIT characters of an MCP
// tool description into the model prompt and silently drops the rest. omp's
// long descriptions (edit, task, todo, hub, eval, read) put the usage examples
// at the END, so the model used to get the prose and lose the examples.
//
// packToolDescription rebuilds a description that fits: the opening summary,
// then the blocks that matter most for calling the tool correctly
// (<critical>, <instruction>, <example>/<examples>), trimmed in priority
// order. The untouched full text goes to the "Full tool reference" section of
// the system prompt (see buildToolReference in index.ts).

export const CC_MCP_DESCRIPTION_LIMIT = 2048;
export const TOOL_REFERENCE_HEADER = "# Full tool reference";

const POINTER = `[Condensed: the complete description is under "${TOOL_REFERENCE_HEADER}" in the system prompt.]\n`;
const POINTER_NO_REF = `[Condensed to fit Claude Code's ${CC_MCP_DESCRIPTION_LIMIT}-char tool description limit.]\n`;
const HEAD_MAX = 700;

// Tag blocks that carry the "how to call it" knowledge, most important first.
const PRIORITY_TAGS = ["critical", "instruction", "examples"];

function extractBlocks(text: string, tag: string): string[] {
	const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
	return text.match(re) ?? [];
}

// Split an <examples> block into its individual <example> entries so we can
// keep as many as fit. A block without inner <example> tags is kept whole.
function exampleEntries(examplesBlock: string): string[] {
	const inner = extractBlocks(examplesBlock, "example");
	return inner.length ? inner : [examplesBlock];
}

function head(text: string): string {
	const firstBreak = text.indexOf("\n\n");
	const h = (firstBreak === -1 ? text : text.slice(0, firstBreak)).trim();
	return h.length > HEAD_MAX ? `${h.slice(0, HEAD_MAX - 1).trimEnd()}…` : h;
}

/**
 * Returns `description` unchanged when it already fits, otherwise a condensed
 * version at most `limit` characters long.
 */
export function packToolDescription(description: string | undefined, limit = CC_MCP_DESCRIPTION_LIMIT, hasReference = true): string | undefined {
	if (!description || description.length <= limit) return description;
	const pointer = hasReference ? POINTER : POINTER_NO_REF;
	const budget = limit - pointer.length;

	const summary = head(description);
	const blocks: string[] = [];
	for (const tag of PRIORITY_TAGS) {
		for (const block of extractBlocks(description, tag)) blocks.push(block);
	}
	// Standalone <example> blocks (edit uses one, outside any <examples>).
	const insideExamples = new Set(extractBlocks(description, "examples").flatMap((b) => extractBlocks(b, "example")));
	for (const ex of extractBlocks(description, "example")) if (!insideExamples.has(ex)) blocks.push(ex);

	// Greedy fill: summary first, then blocks by priority; an <examples> block
	// that doesn't fit whole is refilled example by example.
	const parts: string[] = [summary];
	let used = summary.length;
	const fits = (s: string) => used + 2 + s.length <= budget;
	for (const block of blocks) {
		if (fits(block)) { parts.push(block); used += 2 + block.length; continue; }
		if (block.startsWith("<examples>")) {
			const kept: string[] = [];
			for (const ex of exampleEntries(block)) {
				const candidate = `<examples>\n${[...kept, ex].join("\n")}\n</examples>`;
				if (used + 2 + candidate.length > budget) break;
				kept.push(ex);
			}
			if (kept.length) {
				const wrapped = `<examples>\n${kept.join("\n")}\n</examples>`;
				parts.push(wrapped); used += 2 + wrapped.length;
			}
		}
	}
	// Whatever budget is left goes to the remaining prose, in document order,
	// paragraph by paragraph (so tools without tagged blocks keep their body).
	const taken = new Set(parts);
	let stripped = description;
	for (const block of blocks) stripped = stripped.replace(block, "");
	for (const para of stripped.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
		if (para === summary || taken.has(para)) continue;
		if (!fits(para)) break;
		parts.push(para); used += 2 + para.length; taken.add(para);
	}
	let out = pointer + parts.join("\n\n");
	if (out.length > limit) out = `${out.slice(0, limit - 1).trimEnd()}…`;
	return out;
}

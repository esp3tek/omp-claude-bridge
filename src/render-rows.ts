// Tool renderers return plain rows instead of a pi-tui component.
//
// omp 19.2 rebuilt extension rendering on the host's pi-tui: renderers return pi-tui nodes or a
// rows object `{ render(width): string[] }` (ANSI allowed; rows wider than `width` are cut), and
// the `Text` component the bridge imported from `@oh-my-pi/pi-tui` no longer exists, which made
// the whole extension fail to load. Older hosts take any pi-tui `Component`, whose contract is
// the same `render(width): string[]` (plus `invalidate()`), so one rows object serves both.
// Nothing here imports pi-tui: the host maps that package differently on each version.

export interface Rows {
	render(width: number): string[];
	invalidate(): void;
}

const RESET = "\x1b[0m";
// CSI (SGR and others) and OSC (hyperlinks, titles) sequences: zero width.
const ESCAPE = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

/** Cells a code point takes: 0 for combining marks and joiners, 2 for wide East Asian and emoji. */
function charWidth(cp: number): number {
	if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) return 0;
	if (cp < 0x1100) return 1;
	if (
		cp <= 0x115f ||
		(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	) return 2;
	return 1;
}

type Token = { kind: "esc"; text: string } | { kind: "space" | "word"; chars: string[]; widths: number[] };

function tokenize(line: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < line.length) {
		ESCAPE.lastIndex = i;
		const m = ESCAPE.exec(line);
		if (m) {
			tokens.push({ kind: "esc", text: m[0] });
			i += m[0].length;
			continue;
		}
		const cp = line.codePointAt(i)!;
		const ch = String.fromCodePoint(cp);
		i += ch.length;
		if (ch === "\x1b") continue; // a lone ESC that starts no known sequence
		const kind = ch === " " || ch === "\t" ? "space" : "word";
		const text = ch === "\t" ? "    " : ch;
		const w = ch === "\t" ? 4 : charWidth(cp);
		const last = tokens.at(-1);
		if (last && last.kind === kind) {
			last.chars.push(text);
			last.widths.push(w);
		} else {
			tokens.push({ kind, chars: [text], widths: [w] });
		}
	}
	return tokens;
}

/** Track the SGR styling still active after `seq`, so a wrapped row can reopen it. */
function nextStyle(active: string, seq: string): string {
	if (!seq.startsWith("\x1b[") || !seq.endsWith("m")) return active;
	const params = seq.slice(2, -1);
	return params === "" || params === "0" ? "" : active + seq;
}

/** Word-wrap one ANSI-styled line to `width` cells, reopening the active style on each row. */
function wrapLine(line: string, width: number): string[] {
	const rows: string[] = [];
	let row = "";
	let col = 0;
	let style = "";
	const breakRow = () => {
		rows.push(style ? row + RESET : row);
		row = style;
		col = 0;
	};
	for (const token of tokenize(line)) {
		if (token.kind === "esc") {
			row += token.text;
			style = nextStyle(style, token.text);
			continue;
		}
		const total = token.widths.reduce((a, b) => a + b, 0);
		if (token.kind === "space") {
			if (col + total <= width) {
				row += token.chars.join("");
				col += total;
			} else if (col > 0) {
				breakRow(); // spaces at a break are dropped
			}
			continue;
		}
		if (col + total > width && col > 0 && total <= width) breakRow();
		for (let k = 0; k < token.chars.length; k++) {
			const w = token.widths[k]!;
			if (col + w > width && col > 0) breakRow();
			row += token.chars[k];
			col += w;
		}
	}
	rows.push(row);
	return rows;
}

/** Wrap ANSI-styled text into rows at most `width` cells wide (newlines start new rows). */
export function wrapAnsi(text: string, width: number): string[] {
	const w = Math.max(1, Math.floor(width) || 1);
	return text.split("\n").flatMap((line) => wrapLine(line, w));
}

/** A renderer result that draws `text` word-wrapped at the width the host gives. */
export function textRows(text: string): Rows {
	return {
		render: (width: number) => wrapAnsi(text, width),
		invalidate: () => {},
	};
}

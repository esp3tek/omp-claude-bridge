import { describe, expect, test } from "bun:test";
import { textRows, wrapAnsi } from "../src/render-rows.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

describe("wrapAnsi", () => {
	test("short text stays on one row", () => {
		expect(wrapAnsi("hello world", 20)).toEqual(["hello world"]);
	});

	test("newlines start new rows, empty lines kept", () => {
		expect(wrapAnsi("a\n\nb", 10)).toEqual(["a", "", "b"]);
	});

	test("wraps at word boundaries and drops the space at the break", () => {
		expect(wrapAnsi("alpha beta gamma", 10)).toEqual(["alpha beta", "gamma"]);
	});

	test("hard-splits a word longer than the width", () => {
		expect(wrapAnsi("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
	});

	test("escape sequences take no width", () => {
		const rows = wrapAnsi(`${DIM}alpha${RESET} beta`, 10);
		expect(rows.map(strip)).toEqual(["alpha beta"]);
	});

	test("an active style is closed at the break and reopened on the next row", () => {
		const rows = wrapAnsi(`${DIM}alpha beta gamma${RESET}`, 10);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.endsWith(RESET)).toBe(true);
		expect(rows[1]!.startsWith(DIM)).toBe(true);
		expect(rows.map(strip)).toEqual(["alpha beta", "gamma"]);
	});

	test("no row exceeds the width, wide characters count as two cells", () => {
		const rows = wrapAnsi("日本語のテキスト", 5);
		for (const row of rows) expect([...strip(row)].length * 2).toBeLessThanOrEqual(5 + 1);
		expect(rows.map(strip).join("")).toBe("日本語のテキスト");
	});

	test("a zero or invalid width still returns rows", () => {
		expect(wrapAnsi("ab", 0)).toEqual(["a", "b"]);
		expect(wrapAnsi("ab", Number.NaN)).toEqual(["a", "b"]);
	});
});

describe("textRows", () => {
	test("is a rows object: render(width) and a no-op invalidate", () => {
		const rows = textRows("alpha beta");
		expect(rows.render(5)).toEqual(["alpha", "beta"]);
		expect(rows.render(40)).toEqual(["alpha beta"]);
		expect(() => rows.invalidate()).not.toThrow();
	});
});

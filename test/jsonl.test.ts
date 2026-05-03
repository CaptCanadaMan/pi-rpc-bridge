import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/jsonl.js";

describe("serializeJsonLine", () => {
	it("appends a single LF to JSON", () => {
		expect(serializeJsonLine({ a: 1 })).toBe('{"a":1}\n');
	});

	it("does not escape U+2028 / U+2029 (JSON.stringify default)", () => {
		// These characters are valid in JSON strings and pi's JSONL framing relies
		// on splitting only on \n, not on Unicode separators.
		const line = serializeJsonLine({ s: "  " });
		expect(line.endsWith("\n")).toBe(true);
		expect(line.includes(" ")).toBe(true);
		expect(line.includes(" ")).toBe(true);
	});
});

describe("attachJsonlLineReader", () => {
	function readerFromChunks(chunks: string[]): Promise<string[]> {
		return new Promise((resolve) => {
			const stream = new Readable({ read() {} });
			const lines: string[] = [];
			attachJsonlLineReader(stream, (line) => lines.push(line));
			for (const c of chunks) stream.push(c);
			stream.push(null);
			stream.on("end", () => {
				queueMicrotask(() => resolve(lines));
			});
		});
	}

	it("emits one line per LF", async () => {
		const lines = await readerFromChunks(["a\nb\nc\n"]);
		expect(lines).toEqual(["a", "b", "c"]);
	});

	it("strips trailing CR", async () => {
		const lines = await readerFromChunks(["a\r\nb\r\n"]);
		expect(lines).toEqual(["a", "b"]);
	});

	it("handles a line spanning multiple chunks", async () => {
		const lines = await readerFromChunks(["par", "tial ", "line\n", "next\n"]);
		expect(lines).toEqual(["partial line", "next"]);
	});

	it("emits a final unterminated line on stream end", async () => {
		const lines = await readerFromChunks(["one\ntwo"]);
		expect(lines).toEqual(["one", "two"]);
	});

	it("does not split on U+2028 or U+2029", async () => {
		const lines = await readerFromChunks([`with and more\n`]);
		expect(lines).toEqual([`with and more`]);
	});
});

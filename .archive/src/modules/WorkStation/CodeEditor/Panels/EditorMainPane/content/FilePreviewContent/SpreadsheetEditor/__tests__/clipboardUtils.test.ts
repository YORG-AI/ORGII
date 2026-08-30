import { parseClipboardText, stringifyRangeAsTsv } from "../clipboardUtils";
import type { SpreadsheetData } from "../types";

describe("stringifyRangeAsTsv", () => {
  it("serializes a selected rectangular range as tab-separated rows", () => {
    const data: SpreadsheetData = [
      ["A1", "B1", "C1"],
      ["A2", "B2", "C2"],
      ["A3", "B3", "C3"],
    ];

    expect(
      stringifyRangeAsTsv(data, {
        startRow: 1,
        endRow: 2,
        startColumn: 1,
        endColumn: 2,
      })
    ).toBe("B2\tC2\nB3\tC3");
  });

  it("fills missing cells and rows with empty fields", () => {
    const data: SpreadsheetData = [["A1"], [], ["A3", "B3"]];

    expect(
      stringifyRangeAsTsv(data, {
        startRow: 0,
        endRow: 2,
        startColumn: 0,
        endColumn: 1,
      })
    ).toBe("A1\t\n\t\nA3\tB3");
  });
});

describe("parseClipboardText", () => {
  it("returns one empty cell for empty clipboard text", () => {
    expect(parseClipboardText("")).toEqual([[""]]);
  });

  it("parses tab-delimited clipboard text", () => {
    expect(parseClipboardText("A\tB\nC\tD")).toEqual([
      ["A", "B"],
      ["C", "D"],
    ]);
  });

  it("normalizes CRLF and CR newlines", () => {
    expect(parseClipboardText("A,B\r\nC,D\rE,F")).toEqual([
      ["A", "B"],
      ["C", "D"],
      ["E", "F"],
    ]);
  });

  it("parses comma-delimited text when tabs are absent", () => {
    expect(parseClipboardText("A,B,C\nD,E,F")).toEqual([
      ["A", "B", "C"],
      ["D", "E", "F"],
    ]);
  });

  it("keeps delimiter and newline characters inside quoted fields", () => {
    expect(parseClipboardText('"A,B","line one\nline two",C')).toEqual([
      ["A,B", "line one\nline two", "C"],
    ]);
  });

  it("unescapes doubled quotes inside quoted fields", () => {
    expect(parseClipboardText('"He said ""hello""",Next')).toEqual([
      ['He said "hello"', "Next"],
    ]);
  });

  it("does not append an extra empty row for trailing newline", () => {
    expect(parseClipboardText("A\tB\n")).toEqual([["A", "B"]]);
  });

  it("preserves a trailing empty field after a delimiter", () => {
    expect(parseClipboardText("A\tB\t")).toEqual([["A", "B", ""]]);
  });
});

import { describe, expect, it } from "vitest";

import {
  MAX_EDIT_OPERATION_TEXT_CHARS,
  computeMinimalEdit,
  createEditOperation,
  createMinimalEditOperation,
  filterEditsBySource,
} from "./document";

describe("computeMinimalEdit", () => {
  it("keeps only the inserted span for a mid-document insertion", () => {
    expect(computeMinimalEdit("const a = 1;", "const ab = 1;")).toEqual({
      range: { from: 7, to: 7 },
      newText: "b",
    });
  });

  it("describes a deletion as an empty insertion over the removed range", () => {
    expect(computeMinimalEdit("hello world", "hello")).toEqual({
      range: { from: 5, to: 11 },
      newText: "",
    });
  });

  it("describes a replacement by its changed span only", () => {
    expect(computeMinimalEdit("let x = foo(1);", "let x = bar(1);")).toEqual({
      range: { from: 8, to: 11 },
      newText: "bar",
    });
  });

  it("yields an empty edit when nothing changed", () => {
    expect(computeMinimalEdit("same", "same")).toEqual({
      range: { from: 4, to: 4 },
      newText: "",
    });
  });

  it("treats the first load as an insertion at the start", () => {
    expect(computeMinimalEdit("", "abc")).toEqual({
      range: { from: 0, to: 0 },
      newText: "abc",
    });
  });

  it("handles append and prepend", () => {
    expect(computeMinimalEdit("abc", "abcd")).toEqual({
      range: { from: 3, to: 3 },
      newText: "d",
    });
    expect(computeMinimalEdit("abc", "zabc")).toEqual({
      range: { from: 0, to: 0 },
      newText: "z",
    });
  });

  it("never splits a surrogate pair at either boundary", () => {
    // 😀 is \ud83d\ude00; 😁 is \ud83d\ude01 (shared high surrogate).
    const prefixCase = computeMinimalEdit("a😀", "a😁");
    expect(prefixCase.newText).toBe("😁");
    expect(prefixCase.range).toEqual({ from: 1, to: 3 });

    // 🙂 is \ud83d\ude42; 😂 is \ud83d\ude02 (shared low surrogate? no: distinct)
    // 🍎 is \ud83c\udf4e; 🎎 is \ud83c\udf8e — different second units, same first.
    const suffixCase = computeMinimalEdit("🍎b", "🎎b");
    expect(suffixCase.newText).toBe("🎎");
    expect(suffixCase.range).toEqual({ from: 0, to: 2 });
  });
});

describe("createEditOperation", () => {
  it("retains short insertions in full without a truncation marker", () => {
    const edit = createEditOperation(
      { from: 0, to: 0 },
      "short",
      { type: "human" },
      1
    );
    expect(edit.newText).toBe("short");
    expect(edit.insertedLength).toBe(5);
    expect(edit.truncated).toBeUndefined();
  });

  it("caps retained text while keeping the full inserted length", () => {
    const big = "x".repeat(MAX_EDIT_OPERATION_TEXT_CHARS * 3);
    const edit = createEditOperation(
      { from: 0, to: 0 },
      big,
      { type: "reload" },
      1
    );
    expect(edit.newText.length).toBe(MAX_EDIT_OPERATION_TEXT_CHARS);
    expect(edit.insertedLength).toBe(big.length);
    expect(edit.truncated).toBe(true);
  });

  it("does not end the retained text on a lone high surrogate", () => {
    const filler = "y".repeat(MAX_EDIT_OPERATION_TEXT_CHARS - 1);
    const edit = createEditOperation(
      { from: 0, to: 0 },
      `${filler}😀${"z".repeat(10)}`,
      { type: "human" },
      1
    );
    expect(edit.newText).toBe(filler);
    expect(edit.truncated).toBe(true);
  });
});

describe("createMinimalEditOperation", () => {
  it("stores only the changed span of a keystroke, never the document", () => {
    const document = "a".repeat(50_000);
    const edit = createMinimalEditOperation(
      document,
      `${document.slice(0, 10)}Q${document.slice(10)}`,
      { type: "human" },
      7
    );
    expect(edit.newText).toBe("Q");
    expect(edit.range).toEqual({ from: 10, to: 10 });
    expect(edit.insertedLength).toBe(1);
    expect(edit.versionAfter).toBe(7);
  });

  it("bounds a reload edit by the retention cap", () => {
    const loaded = "line\n".repeat(20_000);
    const edit = createMinimalEditOperation("", loaded, { type: "reload" }, 1);
    expect(edit.newText.length).toBe(MAX_EDIT_OPERATION_TEXT_CHARS);
    expect(edit.insertedLength).toBe(loaded.length);
    expect(filterEditsBySource([edit], "reload")).toHaveLength(1);
  });
});

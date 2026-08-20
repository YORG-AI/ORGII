import { describe, expect, it } from "vitest";

import {
  formatMarkdownTextareaSelection,
  insertMarkdownTextareaText,
  markdownTextareaToPlainText,
} from "./formatting";

describe("formatMarkdownTextareaSelection", () => {
  it("wraps the selected text with inline Markdown", () => {
    expect(
      formatMarkdownTextareaSelection(
        { value: "hello world", start: 6, end: 11 },
        "bold"
      )
    ).toEqual({
      value: "hello **world**",
      selectionStart: 8,
      selectionEnd: 13,
    });
  });

  it("inserts a link and selects its URL when text is selected", () => {
    expect(
      formatMarkdownTextareaSelection(
        { value: "read docs", start: 5, end: 9 },
        "link"
      )
    ).toEqual({
      value: "read [docs](https://)",
      selectionStart: 12,
      selectionEnd: 20,
    });
  });

  it("prefixes every selected line as an ordered list", () => {
    expect(
      formatMarkdownTextareaSelection(
        { value: "one\ntwo\nthree", start: 0, end: 7 },
        "numberedList"
      )
    ).toEqual({
      value: "1. one\n2. two\nthree",
      selectionStart: 0,
      selectionEnd: 13,
    });
  });

  it("moves a collapsed caret after an inserted task marker", () => {
    expect(
      formatMarkdownTextareaSelection(
        { value: "todo", start: 2, end: 2 },
        "taskList"
      )
    ).toEqual({
      value: "- [ ] todo",
      selectionStart: 8,
      selectionEnd: 8,
    });
  });

  it("derives plain text without discarding line breaks", () => {
    expect(
      markdownTextareaToPlainText(
        "## Plan\n\nUse **bold** and [docs](https://x.dev)."
      )
    ).toBe("Plan\n\nUse bold and docs.");
  });

  it("inserts references after an active selection without replacing it", () => {
    expect(
      insertMarkdownTextareaText(
        { value: "keep selected end", start: 5, end: 13 },
        "REF",
        true
      )
    ).toEqual({
      value: "keep selected REF end",
      selectionStart: 17,
      selectionEnd: 17,
    });
  });
});

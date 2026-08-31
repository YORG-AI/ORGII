import { describe, expect, it } from "vitest";

import { splitIntoStableMarkdownBlocks } from "./markdownStableBlocks";

describe("splitIntoStableMarkdownBlocks", () => {
  it("returns a single empty block for empty content", () => {
    expect(splitIntoStableMarkdownBlocks("")).toEqual([""]);
  });

  it("keeps content without a blank line in one block", () => {
    expect(splitIntoStableMarkdownBlocks("one\nparagraph")).toEqual([
      "one\nparagraph",
    ]);
  });

  it("splits on a blank line and keeps the separator on the block", () => {
    expect(splitIntoStableMarkdownBlocks("a\n\nb")).toEqual(["a\n\n", "b"]);
  });

  it("drops whitespace-only blocks", () => {
    expect(splitIntoStableMarkdownBlocks("a\n\n\n\nb")).toEqual(["a\n\n", "b"]);
  });

  it("never splits inside a fenced code block", () => {
    expect(
      splitIntoStableMarkdownBlocks("```js\n\ncode\n```\n\nafter")
    ).toEqual(["```js\n\ncode\n```\n\n", "after"]);
  });

  it("keeps an unterminated fence and everything after it in one block", () => {
    expect(
      splitIntoStableMarkdownBlocks("text\n\n```js\ncode\n\nmore")
    ).toEqual(["text\n\n", "```js\ncode\n\nmore"]);
  });

  it("only closes a fence with a run at least as long as the opener", () => {
    expect(
      splitIntoStableMarkdownBlocks("````\n```\n\nstill\n````\n\nafter")
    ).toEqual(["````\n```\n\nstill\n````\n\n", "after"]);
  });

  it("preserves the content when nothing is dropped", () => {
    const content = "# Title\n\nBody text.\n\n```ts\nconst a = 1;\n```\n\nEnd";
    expect(splitIntoStableMarkdownBlocks(content).join("")).toBe(content);
  });

  it("grows only the trailing block as a stream advances", () => {
    const prefix = "Done paragraph.\n\n";
    const first = splitIntoStableMarkdownBlocks(`${prefix}stream`);
    const second = splitIntoStableMarkdownBlocks(`${prefix}streaming more`);
    expect(first[0]).toBe(second[0]);
    expect(first.at(-1)).not.toBe(second.at(-1));
  });
});

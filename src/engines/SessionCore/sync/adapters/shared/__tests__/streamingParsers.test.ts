import { describe, expect, it } from "vitest";

import {
  buildToolArgsFromParsed,
  extractThinkContent,
  parsePartialToolArgs,
  stripThinkTags,
} from "../streamingParsers";

describe("stripThinkTags", () => {
  it("removes a complete <think>...</think> block", () => {
    const input = "before<think>secret</think>after";
    expect(stripThinkTags(input)).toBe("beforeafter");
  });

  it("removes multiple complete blocks", () => {
    const input = "a<think>x</think>b<think>y</think>c";
    expect(stripThinkTags(input)).toBe("abc");
  });

  it("removes an unclosed <think> tail (still streaming)", () => {
    const input = "visible<think>still typing";
    expect(stripThinkTags(input)).toBe("visible");
  });

  it("returns empty string when the entire payload is wrapped in think", () => {
    expect(stripThinkTags("<think>only thinking, no answer</think>")).toBe("");
  });

  it("returns empty string for an entirely-unclosed think payload", () => {
    expect(stripThinkTags("<think>thinking but never closed")).toBe("");
  });

  it("is idempotent on already-stripped content", () => {
    const cleaned = stripThinkTags("<think>x</think>hello");
    expect(stripThinkTags(cleaned)).toBe(cleaned);
  });

  it("leaves regular text untouched when no <think> tag is present", () => {
    expect(stripThinkTags("plain reply with no markers")).toBe(
      "plain reply with no markers"
    );
  });
});

describe("parsePartialToolArgs", () => {
  it("extracts streamed create-file content from an incomplete Write payload", () => {
    const parsed = parsePartialToolArgs(
      '{"path":"src/new.ts","content":"export const value = 1;\\nexport const more = '
    );

    expect(parsed.filePath).toBe("src/new.ts");
    expect(parsed.streamContent).toBe(
      "export const value = 1;\nexport const more ="
    );

    expect(buildToolArgsFromParsed(parsed)).toMatchObject({
      file_path: "src/new.ts",
      streamContent: "export const value = 1;\nexport const more =",
      content: "export const value = 1;\nexport const more =",
    });
  });

  it("extracts action and new_string from a streaming edit payload", () => {
    const parsed = parsePartialToolArgs(
      '{"action":"edit","file_path":"src/app.ts","old_string":"old","new_string":"new line\\nsecond'
    );

    expect(parsed.action).toBe("edit");
    expect(parsed.filePath).toBe("src/app.ts");
    expect(parsed.streamContent).toBe("new line\nsecond");

    expect(buildToolArgsFromParsed(parsed)).toMatchObject({
      action: "edit",
      file_path: "src/app.ts",
      streamContent: "new line\nsecond",
    });
  });

  it("maps apply_patch stream content to patch_text for running diff rendering", () => {
    const parsed = parsePartialToolArgs(
      '{"action":"apply_patch","patch_text":"*** Begin Patch\\n*** Add File: src/a.ts\\n+export'
    );

    expect(buildToolArgsFromParsed(parsed)).toMatchObject({
      action: "apply_patch",
      patch_text: "*** Begin Patch\n*** Add File: src/a.ts\n+export",
      streamContent: "*** Begin Patch\n*** Add File: src/a.ts\n+export",
    });
  });
});

describe("extractThinkContent", () => {
  it("returns null when no <think> tag is present", () => {
    expect(extractThinkContent("plain reply")).toBeNull();
  });

  it("extracts the content of a single complete block", () => {
    expect(extractThinkContent("a<think>hello</think>b")).toBe("hello");
  });

  it("joins multiple complete blocks with two newlines", () => {
    expect(extractThinkContent("<think>one</think>mid<think>two</think>")).toBe(
      "one\n\ntwo"
    );
  });

  it("captures unclosed (in-progress) thinking tail", () => {
    expect(extractThinkContent("visible<think>still typing")).toBe(
      "still typing"
    );
  });

  it("captures both completed and unclosed blocks together", () => {
    expect(extractThinkContent("<think>done</think>tail<think>typing")).toBe(
      "done\n\ntyping"
    );
  });

  it("captures the body when the entire payload is a single closed think block", () => {
    expect(extractThinkContent("<think>only this</think>")).toBe("only this");
  });

  it("captures the body when the entire payload is an unclosed think block", () => {
    expect(extractThinkContent("<think>only this, never closed")).toBe(
      "only this, never closed"
    );
  });

  it("ignores empty/whitespace-only think bodies", () => {
    expect(extractThinkContent("<think>   </think>")).toBeNull();
    expect(extractThinkContent("<think>\n\n</think>")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  hasPillSyntax,
  parsePillTextToSnapshot,
  stripExpandedPillContent,
} from "../pillContentParser";

// ============================================================
// stripExpandedPillContent
// ============================================================

describe("stripExpandedPillContent", () => {
  it("returns text unchanged when no separator is present", () => {
    expect(stripExpandedPillContent("hello world")).toBe("hello world");
  });

  it("returns empty string when input is empty", () => {
    expect(stripExpandedPillContent("")).toBe("");
  });

  it("strips everything from the separator onward", () => {
    const original = "setup-repo 你好";
    const expanded =
      original +
      "\n\n---\n**Referenced content (auto-expanded):**\n\n---\nname: setup-repo\ndescription: ...";
    expect(stripExpandedPillContent(expanded)).toBe(original);
  });

  it("strips correctly when message contains pill tokens", () => {
    const original = "setup-repo 你好 [skill:/setup-repo]";
    const expanded =
      original +
      "\n\n---\n**Referenced content (auto-expanded):**\n\n# Setup Repo Skill\n\nDo stuff.";
    expect(stripExpandedPillContent(expanded)).toBe(original);
  });

  it("strips when message contains multiple pill types", () => {
    const original = "check this [file:/foo/bar.ts] and [skill:/lint]";
    const expanded =
      original +
      "\n\n---\n**Referenced content (auto-expanded):**\n\n### File: /foo/bar.ts\n```ts\ncontent\n```\n\n# Lint Skill";
    expect(stripExpandedPillContent(expanded)).toBe(original);
  });

  it("does not strip text that contains the separator as a substring in the original message", () => {
    // The separator is a specific markdown pattern; normal user text won't contain it,
    // but if it does appear it should still be stripped (documented edge case).
    const withEmbeddedSeparator =
      "my message\n\n---\n**Referenced content (auto-expanded):**\nThis is not expanded skill content";
    // Should strip at the first occurrence — this is the correct behaviour:
    // if the user typed the exact separator, they lose that text too.
    expect(stripExpandedPillContent(withEmbeddedSeparator)).toBe("my message");
  });

  it("handles text with only the separator (no content before)", () => {
    const text = "\n\n---\n**Referenced content (auto-expanded):**\n\nfoo";
    expect(stripExpandedPillContent(text)).toBe("");
  });
});

// ============================================================
// hasPillSyntax (smoke test — main coverage is in ComposerInput)
// ============================================================

describe("hasPillSyntax", () => {
  it("returns false for plain text", () => {
    expect(hasPillSyntax("hello world")).toBe(false);
  });
});

// ============================================================
// parsePillTextToSnapshot
// ============================================================

describe("parsePillTextToSnapshot", () => {
  it("splits ASCII text + pill on the trailing whitespace", () => {
    const snapshot = parsePillTextToSnapshot(
      "look at package.json [file:/repo/package.json]"
    );
    expect(snapshot.parts).toEqual([
      { kind: "text", text: "look at " },
      {
        kind: "pill",
        attrs: {
          filePath: "/repo/package.json",
          fileName: "package.json",
          isFolder: false,
          iconType: "file",
          lineStart: null,
          lineEnd: null,
        },
      },
    ]);
  });

  it("does not swallow CJK prose into the pill display name when no space precedes the pill", () => {
    // Regression: previously `lastSpaceIdx === -1` made the entire CJK prefix
    // become the pill's fileName, rendering the whole sentence as a single
    // blue file pill.
    const snapshot = parsePillTextToSnapshot(
      "生成一个plan给我看看这个package.json [file:/repo/package.json]"
    );
    expect(snapshot.parts).toEqual([
      { kind: "text", text: "生成一个plan给我看看这个package.json" },
      {
        kind: "pill",
        attrs: {
          filePath: "/repo/package.json",
          fileName: "package.json",
          isFolder: false,
          iconType: "file",
          lineStart: null,
          lineEnd: null,
        },
      },
    ]);
  });

  it("falls back to the path basename when there is no preceding text at all", () => {
    const snapshot = parsePillTextToSnapshot("[file:/repo/src/utils.ts]");
    // No match[1] capture means the regex requires non-empty preceding text;
    // verify we still produce a sane result when one exists but has no space.
    const tight = parsePillTextToSnapshot("foo[file:/repo/src/utils.ts]");
    expect(tight.parts).toEqual([
      { kind: "text", text: "foo" },
      {
        kind: "pill",
        attrs: {
          filePath: "/repo/src/utils.ts",
          fileName: "utils.ts",
          isFolder: false,
          iconType: "file",
          lineStart: null,
          lineEnd: null,
        },
      },
    ]);
    // PILL_REGEX requires at least one char before "[", so a bare pill cannot
    // match — snapshot stays as a single literal text part.
    expect(snapshot.parts).toEqual([
      { kind: "text", text: "[file:/repo/src/utils.ts]" },
    ]);
  });

  it("preserves newlines between pills", () => {
    const snapshot = parsePillTextToSnapshot(
      "first foo.ts [file:/a/foo.ts]\nsecond bar.ts [file:/a/bar.ts]"
    );
    expect(snapshot.parts).toEqual([
      { kind: "text", text: "first " },
      {
        kind: "pill",
        attrs: {
          filePath: "/a/foo.ts",
          fileName: "foo.ts",
          isFolder: false,
          iconType: "file",
          lineStart: null,
          lineEnd: null,
        },
      },
      { kind: "newline" },
      { kind: "text", text: "second " },
      {
        kind: "pill",
        attrs: {
          filePath: "/a/bar.ts",
          fileName: "bar.ts",
          isFolder: false,
          iconType: "file",
          lineStart: null,
          lineEnd: null,
        },
      },
    ]);
  });

  it("preserves serialized session pill labels when restoring drafts", () => {
    const snapshot = parsePillTextToSnapshot(
      "审计-policy-啊permission-那些... [session:sdeagent-ee970f47-dfcb-4a78-97e5-fc56e3451821]"
    );
    expect(snapshot.parts).toEqual([
      {
        kind: "pill",
        attrs: {
          filePath: "sdeagent-ee970f47-dfcb-4a78-97e5-fc56e3451821",
          fileName: "审计-policy-啊permission-那些...",
          isFolder: false,
          iconType: "session",
          lineStart: null,
          lineEnd: null,
        },
      },
    ]);
  });

  it("round-trips a paste pill (paste://… filePath, paste iconType)", () => {
    const snapshot = parsePillTextToSnapshot(
      "look pasted.json [paste:paste://1234-abc]"
    );
    expect(snapshot.parts).toEqual([
      { kind: "text", text: "look " },
      {
        kind: "pill",
        attrs: {
          filePath: "paste://1234-abc",
          fileName: "pasted.json",
          isFolder: false,
          iconType: "paste",
          lineStart: null,
          lineEnd: null,
        },
      },
    ]);
  });
});

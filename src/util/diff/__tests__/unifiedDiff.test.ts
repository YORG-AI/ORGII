import { describe, expect, it } from "vitest";

import {
  countUnifiedDiffLines,
  mergeUnifiedDiffStrings,
  parseUnifiedDiff,
  parseUnifiedDiffToOldNew,
} from "../unifiedDiff";

describe("canonical unified diff helpers", () => {
  it("supports compact parsing without placeholder gaps", () => {
    const diff = [
      "@@ -2,1 +2,1 @@",
      "-old one",
      "+new one",
      "@@ -20,1 +20,1 @@",
      "-old two",
      "+new two",
    ].join("\n");

    expect(parseUnifiedDiffToOldNew(diff)).toEqual({
      oldValue: "old one\nold two",
      newValue: "new one\nnew two",
      oldStartLine: 2,
      newStartLine: 2,
    });
    expect(parseUnifiedDiff(diff).oldValue).toContain("\n\n");
  });

  it("counts only added and removed payload lines", () => {
    const diff = [
      "diff --git a/file b/file",
      "--- a/file",
      "+++ b/file",
      "@@ -1,2 +1,2 @@",
      " context",
      "-before",
      "+after",
    ].join("\n");

    expect(countUnifiedDiffLines(diff)).toEqual({ additions: 1, deletions: 1 });
  });

  it("does not mistake payload beginning with two signs for file headers", () => {
    const parsed = parseUnifiedDiff(
      ["@@ -1 +1 @@", "---flag", "+++value"].join("\n")
    );

    expect(parsed.oldValue).toBe("--flag");
    expect(parsed.newValue).toBe("++value");
    expect(parsed.stats).toEqual({ additions: 1, deletions: 1 });
  });

  it("merges hunks in line order and preserves non-line payload markers", () => {
    const merged = mergeUnifiedDiffStrings([
      ["@@ -10,1 +10,1 @@", "-old", "+new", ""].join("\n"),
      [
        "@@ -2,1 +2,1 @@",
        "-before",
        "+after",
        "\\ No newline at end of file",
      ].join("\n"),
    ]);

    expect(merged.indexOf("@@ -2,1 +2,1 @@")).toBeLessThan(
      merged.indexOf("@@ -10,1 +10,1 @@")
    );
    expect(merged).toContain("\\ No newline at end of file");
  });

  it("keeps the later hunk when old-file ranges overlap", () => {
    expect(
      mergeUnifiedDiffStrings([
        "@@ -4,3 +4,3 @@\n-old\n+first",
        "@@ -5,1 +5,1 @@\n-old\n+last",
      ])
    ).toBe("@@ -5,1 +5,1 @@\n-old\n+last");
  });

  it("keeps edit order semantics when the later hunk starts earlier", () => {
    expect(
      mergeUnifiedDiffStrings([
        "@@ -5,2 +5,2 @@\n-old\n+first",
        "@@ -4,3 +4,3 @@\n-old\n+last",
      ])
    ).toBe("@@ -4,3 +4,3 @@\n-old\n+last");
  });
});

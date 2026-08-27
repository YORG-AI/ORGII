import { describe, expect, it } from "vitest";

import type { OrgtrackSessionFinalDiff } from "@src/api/tauri/lineage";

import { finalDiffToSection } from "../index";

function makeFinalDiff(
  overrides: Partial<OrgtrackSessionFinalDiff> = {}
): OrgtrackSessionFinalDiff {
  return {
    schemaVersion: 1,
    recordId: "rec-1",
    source: "sdeagent",
    sessionId: "sess-1",
    filePath: "src/foo.ts",
    baselineEventId: null,
    finalEventId: null,
    oldContent: null,
    newContent: null,
    diff: null,
    linesAdded: 0,
    linesRemoved: 0,
    isDeleted: false,
    quality: "patch_reversible",
    differsFromSummedChunks: false,
    computedAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("finalDiffToSection", () => {
  it("renders diff-only records as one unified diff content pair", () => {
    const diff = `--- src/foo.ts
+++ src/foo.ts
@@ -1,3 +1,3 @@
 const hello = "world";
-const bar = "baz";
+const qux = "corge";
`;

    const section = finalDiffToSection(makeFinalDiff({ diff }));

    expect(section.file.isUnavailable).toBeFalsy();
    expect(section.file.unifiedDiff).toBe(diff);
    expect(section.file.oldContent).toBe(`const hello = "world";
const bar = "baz";`);
    expect(section.file.newContent).toBe(`const hello = "world";
const qux = "corge";`);
    expect(section.file.oldStartLine).toBe(1);
    expect(section.file.newStartLine).toBe(1);
  });

  it("uses Rust oldContent/newContent when available and preserves raw unified diff", () => {
    const diff = `--- src/bar.ts
+++ src/bar.ts
@@ -1,1 +1,1 @@
-old line
+new line
`;

    const section = finalDiffToSection(
      makeFinalDiff({
        oldContent: "original content",
        newContent: "modified content",
        diff,
      })
    );

    expect(section.file.isUnavailable).toBeFalsy();
    expect(section.file.oldContent).toBe("original content");
    expect(section.file.newContent).toBe("modified content");
    expect(section.file.unifiedDiff).toBe(diff);
  });

  it("marks unavailable when all content fields are null", () => {
    const section = finalDiffToSection(makeFinalDiff({}));

    expect(section.file.isUnavailable).toBe(true);
    expect(section.file.oldContent).toBeUndefined();
    expect(section.file.newContent).toBeUndefined();
  });

  it("handles deleted file with diff only", () => {
    const diff = `--- src/deleted.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;

    const section = finalDiffToSection(
      makeFinalDiff({ isDeleted: true, diff })
    );

    expect(section.file.status).toBe("deleted");
    expect(section.file.isUnavailable).toBeFalsy();
    expect(section.file.unifiedDiff).toBe(diff);
    expect(section.file.oldContent).toBe(`line one
line two`);
    expect(section.file.newContent).toBe("");
  });

  it("parses multi-hunk diffs into one unified content pair", () => {
    const diff = `--- src/multi.ts
+++ src/multi.ts
@@ -1,2 +1,2 @@
 aaa
-bbb
+BBB
@@ -10,2 +10,2 @@
 jjj
-kkk
+KKK
`;

    const section = finalDiffToSection(makeFinalDiff({ diff }));

    expect(section.file.isUnavailable).toBeFalsy();
    expect(section.file.unifiedDiff).toBe(diff);
    expect(section.file.oldContent).toBe("aaa\nbbb\njjj\nkkk");
    expect(section.file.newContent).toBe("aaa\nBBB\njjj\nKKK");
    expect(section.file.oldContent).not.toContain("\n\n");
    expect(section.file.newContent).not.toContain("\n\n");
  });

  it("distinguishes deletion from missing old/new content", () => {
    const diff = `--- src/only-removed.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-removed
`;

    const section = finalDiffToSection(
      makeFinalDiff({
        diff,
        oldContent: null,
        newContent: "should be ignored for deleted",
        isDeleted: true,
      })
    );

    expect(section.file.status).toBe("deleted");
    expect(section.file.unifiedDiff).toBe(diff);
    expect(section.file.oldContent).toBe("removed");
    expect(section.file.newContent).toBe("");
  });
});

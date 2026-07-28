import { describe, expect, it } from "vitest";

import {
  extractApplyPatchDataFromRust,
  extractEditData,
} from "../propsDataExtractors";
import { makeUniversalProps } from "./fixtures";

// ============================================
// extractEditData
// ============================================

describe("extractEditData", () => {
  describe("standard edit (str_replace style)", () => {
    it("extracts filePath, oldContent, newContent from args", () => {
      const props = makeUniversalProps({
        args: {
          file_path: "src/app.ts",
          old_str: "const x = 1;",
          new_str: "const x = 2;",
        },
      });
      const data = extractEditData(props);
      expect(data.filePath).toBe("src/app.ts");
      expect(data.oldContent).toBe("const x = 1;");
      expect(data.newContent).toBe("const x = 2;");
    });

    it("supports old_string / new_string aliases", () => {
      const props = makeUniversalProps({
        args: {
          file_path: "src/app.ts",
          old_string: "old code",
          new_string: "new code",
        },
      });
      const data = extractEditData(props);
      expect(data.oldContent).toBe("old code");
      expect(data.newContent).toBe("new code");
    });

    it("supports old_content / new_content aliases", () => {
      const props = makeUniversalProps({
        args: {
          file_path: "src/app.ts",
          old_content: "old",
          new_content: "new",
        },
      });
      const data = extractEditData(props);
      expect(data.oldContent).toBe("old");
      expect(data.newContent).toBe("new");
    });

    it("extracts diff from successData.diffString", () => {
      const diffStr = "--- src/app.ts\n+++ src/app.ts\n@@ -1 +1 @@\n-old\n+new";
      const props = makeUniversalProps({
        args: { file_path: "src/app.ts" },
        result: {
          output: { success: { diffString: diffStr, path: "src/app.ts" } },
        },
      });
      expect(extractEditData(props).diff).toBe(diffStr);
    });

    it("extracts diff from result.diff as fallback", () => {
      const diffStr = "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y";
      const props = makeUniversalProps({
        args: { file_path: "src/app.ts" },
        result: { diff: diffStr },
      });
      expect(extractEditData(props).diff).toBe(diffStr);
    });

    it("extracts diff from result.output.diff fallback", () => {
      const diffStr = "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y";
      const props = makeUniversalProps({
        args: { file_path: "src/app.ts" },
        result: { output: { diff: diffStr } },
      });
      expect(extractEditData(props).diff).toBe(diffStr);
    });

    it("extracts linesAdded and linesRemoved from successData", () => {
      const props = makeUniversalProps({
        args: { file_path: "src/app.ts" },
        result: {
          output: {
            success: {
              linesAdded: 5,
              linesRemoved: 3,
              diffString: "some diff",
            },
          },
        },
      });
      const data = extractEditData(props);
      expect(data.linesAdded).toBe(5);
      expect(data.linesRemoved).toBe(3);
    });

    it("extracts beforeFullFileContent and afterFullFileContent from successData", () => {
      const props = makeUniversalProps({
        args: { file_path: "src/app.ts" },
        result: {
          output: {
            success: {
              beforeFullFileContent: "old full content",
              afterFullFileContent: "new full content",
              diffString: "diff",
            },
          },
        },
      });
      const data = extractEditData(props);
      expect(data.oldContent).toBe("old full content");
      expect(data.newContent).toBe("new full content");
    });

    it("result.diffString fallback when successData has no diffString", () => {
      const props = makeUniversalProps({
        args: { file_path: "src/app.ts" },
        result: { diffString: "result-level diff" },
      });
      expect(extractEditData(props).diff).toBe("result-level diff");
    });
  });

  describe("full-write detection", () => {
    it("computes linesAdded from newContent when no diff/oldContent/lineStats", () => {
      const props = makeUniversalProps({
        args: {
          file_path: "src/new.ts",
          content: "line1\nline2\nline3\nline4",
        },
      });
      const data = extractEditData(props);
      expect(data.newContent).toBe("line1\nline2\nline3\nline4");
      expect(data.linesAdded).toBe(4);
      expect(data.oldContent).toBeUndefined();
      expect(data.diff).toBeUndefined();
    });

    it("does NOT compute linesAdded when diff is present", () => {
      const props = makeUniversalProps({
        args: { file_path: "src/app.ts", new_str: "abc\ndef" },
        result: {
          output: {
            success: { diffString: "some diff", linesAdded: 10 },
          },
        },
      });
      const data = extractEditData(props);
      expect(data.linesAdded).toBe(10);
    });
  });

  describe("apply_patch format", () => {
    it("parses Add File into unified diff", () => {
      const patchText = [
        "*** Begin Patch",
        "*** Add File: src/newFile.ts",
        "+export const greeting = 'hello';",
        "+export const farewell = 'bye';",
        "*** End Patch",
      ].join("\n");
      const props = makeUniversalProps({
        args: { patch_text: patchText },
      });
      const data = extractEditData(props);
      expect(data.filePath).toBe("src/newFile.ts");
      expect(data.fileName).toBe("newFile.ts");
      expect(data.diff).toContain("+++ src/newFile.ts");
      expect(data.diff).toContain("--- /dev/null");
      expect(data.linesAdded).toBe(2);
      expect(data.linesRemoved).toBe(0);
    });

    it("parses Modify File into unified diff with hunk headers", () => {
      const patchText = [
        "*** Begin Patch",
        "*** Modify File: src/existing.ts",
        "-const old = true;",
        "+const updated = true;",
        " const unchanged = 42;",
        "*** End Patch",
      ].join("\n");
      const props = makeUniversalProps({
        args: { patch_text: patchText },
      });
      const data = extractEditData(props);
      expect(data.diff).toContain("--- src/existing.ts");
      expect(data.diff).toContain("+++ src/existing.ts");
      expect(data.diff).toMatch(/@@ -1,\d+ \+1,\d+ @@/);
      expect(data.linesAdded).toBe(1);
      expect(data.linesRemoved).toBe(1);
    });

    it("parses Codex Update File patches into unified diff", () => {
      const patchText = [
        "*** Begin Patch",
        "*** Update File: src/existing.ts",
        "@@",
        "-const old = true;",
        "+const updated = true;",
        " const unchanged = 42;",
        "*** End Patch",
      ].join("\n");
      const props = makeUniversalProps({
        args: { patch_text: patchText },
      });
      const data = extractEditData(props);
      expect(data.filePath).toBe("src/existing.ts");
      expect(data.fileName).toBe("existing.ts");
      expect(data.diff).toContain("--- src/existing.ts");
      expect(data.diff).toContain("+++ src/existing.ts");
      expect(data.diff).toContain("-const old = true;");
      expect(data.diff).toContain("+const updated = true;");
      expect(data.diff).not.toContain("\n@@\n@@");
      expect(data.linesAdded).toBe(1);
      expect(data.linesRemoved).toBe(1);
      expect(data.applyPatchSegments).toHaveLength(1);
      expect(data.applyPatchSegments?.[0]?.filePath).toBe("src/existing.ts");
    });

    it("multi-file patch sync path produces combined diff with per-file segments", () => {
      const patchText = [
        "*** Begin Patch",
        "*** Add File: src/a.ts",
        "+const a = 1;",
        "*** Modify File: src/b.ts",
        "-old",
        "+new",
        "*** Add File: src/c.ts",
        "+const c = 3;",
        "*** End Patch",
      ].join("\n");
      const props = makeUniversalProps({
        args: { patch_text: patchText },
      });
      const data = extractEditData(props);
      expect(data.filePath).toBe("src/a.ts");
      expect(data.fileName).toBe("a.ts");
      expect(data.diff).toContain("+const a = 1;");
      expect(data.diff).toContain("+new");
      expect(data.diff).toContain("+const c = 3;");
      expect(data.linesAdded).toBe(3);
      expect(data.linesRemoved).toBe(1);
      expect(data.applyPatchSegments).toHaveLength(3);
      expect(data.applyPatchSegments?.[0]?.filePath).toBe("src/a.ts");
      expect(data.applyPatchSegments?.[0]?.linesAdded).toBe(1);
      expect(data.applyPatchSegments?.[1]?.filePath).toBe("src/b.ts");
      expect(data.applyPatchSegments?.[1]?.linesRemoved).toBe(1);
      expect(data.applyPatchSegments?.[2]?.filePath).toBe("src/c.ts");
    });

    it("parses apply_patch text from args.patch", () => {
      const patchText = [
        "*** Begin Patch",
        "*** Update File: src/from-patch.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n");
      const props = makeUniversalProps({
        args: { patch: patchText },
      });
      const data = extractEditData(props);
      expect(data.filePath).toBe("src/from-patch.ts");
      expect(data.fileName).toBe("from-patch.ts");
      expect(data.applyPatchSegments).toHaveLength(1);
      expect(data.linesAdded).toBe(1);
      expect(data.linesRemoved).toBe(1);
      expect(data.oldStartLine).toBeUndefined();
      expect(data.newStartLine).toBeUndefined();
      expect(data.applyPatchSegments?.[0]?.oldStartLine).toBeUndefined();
      expect(data.applyPatchSegments?.[0]?.newStartLine).toBeUndefined();
    });

    it("preserves explicit apply_patch hunk line ranges", () => {
      const patchText = [
        "*** Begin Patch",
        "*** Update File: src/ranged.ts",
        "@@ -42,2 +43,2 @@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n");
      const props = makeUniversalProps({
        args: { patch: patchText },
      });
      const data = extractEditData(props);
      expect(data.filePath).toBe("src/ranged.ts");
      expect(data.oldStartLine).toBe(42);
      expect(data.newStartLine).toBe(43);
      expect(data.applyPatchSegments?.[0]?.oldStartLine).toBe(42);
      expect(data.applyPatchSegments?.[0]?.newStartLine).toBe(43);
    });

    it("repairs stale Rust patch placeholders from args.patch", () => {
      const patchText = [
        "*** Begin Patch",
        "*** Update File: src/repaired.ts",
        "@@",
        "-const oldValue = true;",
        "+const newValue = true;",
        "*** End Patch",
      ].join("\n");
      const props = makeUniversalProps({
        args: { patch: patchText },
        rustExtracted: {
          kind: "edit",
          filePath: "",
          fileName: "patch",
          language: "diff",
          diff: "",
          linesAdded: 0,
          linesRemoved: 0,
          isDeleted: false,
          applyPatchSegments: [],
        },
      });
      const data = extractEditData(props);
      expect(data.filePath).toBe("src/repaired.ts");
      expect(data.fileName).toBe("repaired.ts");
      expect(data.applyPatchSegments).toHaveLength(1);
      expect(data.applyPatchSegments?.[0]?.filePath).toBe("src/repaired.ts");
      expect(data.linesAdded).toBe(1);
      expect(data.linesRemoved).toBe(1);
    });

    it("computes line counts from patch diff lines", () => {
      const patchText = [
        "*** Begin Patch",
        "*** Modify File: src/file.ts",
        "-removed line one",
        "-removed line two",
        "+added line one",
        "+added line two",
        "+added line three",
        " context line",
        "*** End Patch",
      ].join("\n");
      const props = makeUniversalProps({
        args: { patch_text: patchText },
      });
      const data = extractEditData(props);
      expect(data.linesAdded).toBe(3);
      expect(data.linesRemoved).toBe(2);
    });

    it("uses result.content as newContent when diff is empty (no file directives)", () => {
      const patchText = "*** Begin Patch\n*** End Patch";
      const props = makeUniversalProps({
        args: { patch_text: patchText },
        result: { content: "Patch applied successfully" },
      });
      const data = extractEditData(props);
      expect(data.newContent).toBe("Patch applied successfully");
    });

    it("uses diff language for single-file patch with known extension", () => {
      const patchText = [
        "*** Begin Patch",
        "*** Add File: src/component.tsx",
        "+export default function Comp() {}",
        "*** End Patch",
      ].join("\n");
      const props = makeUniversalProps({
        args: { patch_text: patchText },
      });
      const data = extractEditData(props);
      expect(data.language).toBe("diff");
    });

    it("uses diff language for multi-file patches", () => {
      const patchText = [
        "*** Begin Patch",
        "*** Add File: src/a.ts",
        "+a",
        "*** Add File: src/b.py",
        "+b",
        "*** End Patch",
      ].join("\n");
      const props = makeUniversalProps({
        args: { patch_text: patchText },
      });
      expect(extractEditData(props).language).toBe("diff");
    });
  });

  describe("extractApplyPatchDataFromRust", () => {
    it("maps Rust segments into applyPatchSegments", () => {
      const rustResult = {
        diff: "--- /dev/null\n+++ src/a.ts\n@@ -0,0 +1,1 @@\n+const a = 1;\n--- src/b.ts\n+++ src/b.ts\n@@ -1,1 +1,1 @@\n-old\n+new",
        linesAdded: 2,
        linesRemoved: 1,
        filePaths: ["src/a.ts", "src/b.ts"],
        segments: [
          {
            filePath: "src/a.ts",
            diff: "--- /dev/null\n+++ src/a.ts\n@@ -0,0 +1,1 @@\n+const a = 1;",
            linesAdded: 1,
            linesRemoved: 0,
            isDeleted: false,
          },
          {
            filePath: "src/b.ts",
            diff: "--- src/b.ts\n+++ src/b.ts\n@@ -1,1 +1,1 @@\n-old\n+new",
            linesAdded: 1,
            linesRemoved: 1,
            isDeleted: false,
          },
        ],
      };
      const data = extractApplyPatchDataFromRust(rustResult, undefined);
      expect(data.applyPatchSegments).toHaveLength(2);
      expect(data.applyPatchSegments?.[0]?.filePath).toBe("src/a.ts");
      expect(data.applyPatchSegments?.[0]?.fileName).toBe("a.ts");
      expect(data.applyPatchSegments?.[0]?.linesAdded).toBe(1);
      expect(data.applyPatchSegments?.[1]?.filePath).toBe("src/b.ts");
      expect(data.applyPatchSegments?.[1]?.linesRemoved).toBe(1);
      expect(data.diff).toBe(rustResult.diff);
      expect(data.linesAdded).toBe(2);
      expect(data.linesRemoved).toBe(1);
    });

    it("returns empty edit data when Rust result has no segments", () => {
      const rustResult = {
        diff: "",
        linesAdded: 0,
        linesRemoved: 0,
        filePaths: [],
        segments: [],
      };
      const data = extractApplyPatchDataFromRust(rustResult, {
        content: "Patch applied",
      });
      expect(data.filePath).toBe("");
      expect(data.fileName).toBe("patch");
      expect(data.newContent).toBe("Patch applied");
      expect(data.applyPatchSegments).toBeUndefined();
    });

    it("maps isDeleted Rust segments into applyPatchSegments with isDeleted flag", () => {
      const rustResult = {
        diff: "--- /dev/null\n+++ src/a.ts\n@@ -0,0 +1,1 @@\n+const a = 1;\n--- src/old.ts\n+++ /dev/null",
        linesAdded: 1,
        linesRemoved: 0,
        filePaths: ["src/a.ts", "src/old.ts"],
        segments: [
          {
            filePath: "src/a.ts",
            diff: "--- /dev/null\n+++ src/a.ts\n@@ -0,0 +1,1 @@\n+const a = 1;",
            linesAdded: 1,
            linesRemoved: 0,
            isDeleted: false,
          },
          {
            filePath: "src/old.ts",
            diff: "--- src/old.ts\n+++ /dev/null",
            linesAdded: 0,
            linesRemoved: 0,
            isDeleted: true,
          },
        ],
      };
      const data = extractApplyPatchDataFromRust(rustResult, undefined);
      expect(data.applyPatchSegments).toHaveLength(2);
      expect(data.applyPatchSegments?.[0]?.isDeleted).toBeUndefined();
      expect(data.applyPatchSegments?.[1]?.isDeleted).toBe(true);
      expect(data.applyPatchSegments?.[1]?.filePath).toBe("src/old.ts");
      expect(data.applyPatchSegments?.[1]?.fileName).toBe("old.ts");
    });

    it("assigns result summary to last segment newContent when no diff", () => {
      const rustResult = {
        diff: "",
        linesAdded: 0,
        linesRemoved: 0,
        filePaths: ["src/empty.ts"],
        segments: [
          {
            filePath: "src/empty.ts",
            diff: "",
            linesAdded: 0,
            linesRemoved: 0,
            isDeleted: false,
          },
        ],
      };
      const data = extractApplyPatchDataFromRust(rustResult, {
        content: "Applied successfully",
      });
      expect(data.applyPatchSegments).toHaveLength(1);
      expect(data.applyPatchSegments?.[0]?.newContent).toBe(
        "Applied successfully"
      );
    });
  });

  describe("streamContent for streaming edits", () => {
    it("picks up args.streamContent as newContent", () => {
      const props = makeUniversalProps({
        args: {
          file_path: "src/app.ts",
          streamContent: "const streaming = true;",
        },
      });
      const data = extractEditData(props);
      expect(data.newContent).toBe("const streaming = true;");
    });
  });
});

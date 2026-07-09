import { describe, expect, it } from "vitest";

import {
  extractApplyPatchDataFromRust,
  extractEditData,
  extractFailureData,
  extractFileData,
  extractSearchData,
  extractShellData,
  extractSuccessData,
  extractThinkingData,
  extractTodoData,
  safeText,
} from "../propsDataExtractors";
import { makeUniversalProps } from "./fixtures";

// ============================================
// safeText
// ============================================

describe("safeText", () => {
  it("returns undefined for null/undefined/empty string/false/0", () => {
    expect(safeText(null)).toBeUndefined();
    expect(safeText(undefined)).toBeUndefined();
    expect(safeText("")).toBeUndefined();
    expect(safeText(0)).toBeUndefined();
    expect(safeText(false)).toBeUndefined();
  });

  it("returns the string directly for string input", () => {
    expect(safeText("hello world")).toBe("hello world");
    expect(safeText("multi\nline\ntext")).toBe("multi\nline\ntext");
  });

  it("extracts content from {content: string}", () => {
    expect(safeText({ content: "from content" })).toBe("from content");
  });

  it("extracts content from {role, content} format", () => {
    expect(safeText({ role: "assistant", content: "response text" })).toBe(
      "response text"
    );
  });

  it("extracts text from {text: string}", () => {
    expect(safeText({ text: "from text" })).toBe("from text");
  });

  it("extracts message from {message: string}", () => {
    expect(safeText({ message: "from message" })).toBe("from message");
  });

  it("prioritizes content over text over message", () => {
    expect(safeText({ content: "c", text: "t", message: "m" })).toBe("c");
    expect(safeText({ text: "t", message: "m" })).toBe("t");
  });

  it("extracts first viable item from arrays", () => {
    expect(safeText(["first string", "second"])).toBe("first string");
    expect(safeText([null, undefined, "third"])).toBe("third");
    expect(safeText([{ content: "nested" }, "plain"])).toBe("nested");
  });

  it("returns undefined for arrays with no extractable content", () => {
    expect(safeText([null, undefined, 0])).toBeUndefined();
    expect(safeText([])).toBeUndefined();
  });

  it("returns undefined for objects with no recognized keys", () => {
    expect(safeText({ foo: "bar", count: 42 })).toBeUndefined();
  });

  it("returns undefined for number input (truthy but not string/object-with-keys)", () => {
    expect(safeText(42)).toBeUndefined();
  });
});

// ============================================
// extractSuccessData / extractFailureData
// ============================================

describe("extractSuccessData", () => {
  it("returns empty object for undefined result", () => {
    expect(extractSuccessData(undefined)).toEqual({});
  });

  it("returns empty object when neither nested nor flat success exists", () => {
    expect(extractSuccessData({ someField: "value" })).toEqual({});
  });

  it("extracts nested result.output.success", () => {
    const result = {
      output: { success: { path: "/file.ts", content: "hello" } },
    };
    expect(extractSuccessData(result)).toEqual({
      path: "/file.ts",
      content: "hello",
    });
  });

  it("extracts flat result.success", () => {
    const result = { success: { path: "/file.ts", content: "hello" } };
    expect(extractSuccessData(result)).toEqual({
      path: "/file.ts",
      content: "hello",
    });
  });

  it("nested success takes priority over flat success", () => {
    const result = {
      output: { success: { source: "nested" } },
      success: { source: "flat" },
    };
    expect(extractSuccessData(result)).toEqual({ source: "nested" });
  });

  it("falls back to flat when nested success is empty object", () => {
    const result = {
      output: { success: {} },
      success: { source: "flat" },
    };
    expect(extractSuccessData(result)).toEqual({ source: "flat" });
  });
});

describe("extractFailureData", () => {
  it("returns empty object for undefined result", () => {
    expect(extractFailureData(undefined)).toEqual({});
  });

  it("extracts nested result.output.failure", () => {
    const result = {
      output: { failure: { error: "File not found", code: "ENOENT" } },
    };
    expect(extractFailureData(result)).toEqual({
      error: "File not found",
      code: "ENOENT",
    });
  });

  it("extracts flat result.failure", () => {
    const result = { failure: { error: "timeout" } };
    expect(extractFailureData(result)).toEqual({ error: "timeout" });
  });

  it("nested failure takes priority over flat failure", () => {
    const result = {
      output: { failure: { source: "nested" } },
      failure: { source: "flat" },
    };
    expect(extractFailureData(result)).toEqual({ source: "nested" });
  });
});

// ============================================
// extractThinkingData
// ============================================

describe("extractThinkingData", () => {
  it("returns content and duration as undefined when all sources are empty", () => {
    const props = makeUniversalProps({ args: {}, result: {} });
    const data = extractThinkingData(props);
    expect(data.content).toBeUndefined();
    expect(data.duration).toBeUndefined();
  });

  it("streamingContent takes top priority", () => {
    const props = makeUniversalProps({
      streamingContent: "streaming text",
      result: {
        thought: "thought text",
        content: "content text",
        observation: "obs text",
      },
      args: { content: "args content" },
    });
    expect(extractThinkingData(props).content).toBe("streaming text");
  });

  it("result.thought is next priority after streamingContent", () => {
    const props = makeUniversalProps({
      result: {
        thought: "thought text",
        content: "content text",
        observation: "obs text",
      },
      args: { content: "args content" },
    });
    expect(extractThinkingData(props).content).toBe("thought text");
  });

  it("result.content is next fallback", () => {
    const props = makeUniversalProps({
      result: { content: "content text", observation: "obs" },
      args: { content: "args content" },
    });
    expect(extractThinkingData(props).content).toBe("content text");
  });

  it("result.observation is next fallback", () => {
    const props = makeUniversalProps({
      result: { observation: "obs text" },
      args: { content: "args content" },
    });
    expect(extractThinkingData(props).content).toBe("obs text");
  });

  it("args.content is last fallback", () => {
    const props = makeUniversalProps({
      result: {},
      args: { content: "args content" },
    });
    expect(extractThinkingData(props).content).toBe("args content");
  });

  it("extracts legacy second duration from result", () => {
    const props = makeUniversalProps({ result: { duration: 3.5 } });
    expect(extractThinkingData(props).duration).toBe(3500);
  });

  it("extracts millisecond duration from result", () => {
    const props = makeUniversalProps({ result: { durationMs: 3500 } });
    expect(extractThinkingData(props).duration).toBe(3500);
  });

  it("duration is undefined when result.duration is 0", () => {
    const props = makeUniversalProps({ result: { duration: 0 } });
    expect(extractThinkingData(props).duration).toBeUndefined();
  });
});

// ============================================
// extractFileData
// ============================================

describe("extractFileData", () => {
  describe("filePath extraction", () => {
    it("gets filePath from args.file_path", () => {
      const props = makeUniversalProps({
        args: { file_path: "src/utils/helpers.ts" },
      });
      expect(extractFileData(props).filePath).toBe("src/utils/helpers.ts");
    });

    it("gets filePath from args.target_file", () => {
      const props = makeUniversalProps({
        args: { target_file: "src/target.ts" },
      });
      expect(extractFileData(props).filePath).toBe("src/target.ts");
    });

    it("gets filePath from camel-case Cursor read args", () => {
      const props = makeUniversalProps({
        args: { targetFile: "/Users/vinceorz/Projects/ORGII/src/app/root.tsx" },
      });
      expect(extractFileData(props).filePath).toBe(
        "/Users/vinceorz/Projects/ORGII/src/app/root.tsx"
      );
    });

    it("gets filePath from args.path", () => {
      const props = makeUniversalProps({ args: { path: "src/path.ts" } });
      expect(extractFileData(props).filePath).toBe("src/path.ts");
    });

    it("falls back when rust extracted file path is empty", () => {
      const props = makeUniversalProps({
        args: { path: "packages/web/src/App.tsx" },
        rustExtracted: {
          kind: "file",
          filePath: "",
          fileName: "",
          language: "plaintext",
        },
      });
      expect(extractFileData(props).filePath).toBe("packages/web/src/App.tsx");
      expect(extractFileData(props).fileName).toBe("App.tsx");
    });

    it("gets filePath from successData.path", () => {
      const props = makeUniversalProps({
        result: { output: { success: { path: "src/success.ts" } } },
      });
      expect(extractFileData(props).filePath).toBe("src/success.ts");
    });

    it("gets filePath from successData.file_path", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { file_path: "src/success-fp.ts" } },
        },
      });
      expect(extractFileData(props).filePath).toBe("src/success-fp.ts");
    });

    it("gets filePath from result.file_path", () => {
      const props = makeUniversalProps({
        result: { file_path: "src/result-fp.ts" },
      });
      expect(extractFileData(props).filePath).toBe("src/result-fp.ts");
    });

    it("gets filePath from result.path", () => {
      const props = makeUniversalProps({
        result: { path: "src/result-path.ts" },
      });
      expect(extractFileData(props).filePath).toBe("src/result-path.ts");
    });

    it("args.file_path takes priority over successData.path", () => {
      const props = makeUniversalProps({
        args: { file_path: "from-args.ts" },
        result: { output: { success: { path: "from-success.ts" } } },
      });
      expect(extractFileData(props).filePath).toBe("from-args.ts");
    });

    it("returns empty string when no path source exists", () => {
      const props = makeUniversalProps({ args: {}, result: {} });
      expect(extractFileData(props).filePath).toBe("");
    });
  });

  describe("fileName extraction", () => {
    it("extracts fileName from filePath", () => {
      const props = makeUniversalProps({
        args: { file_path: "src/deep/nested/Component.tsx" },
      });
      expect(extractFileData(props).fileName).toBe("Component.tsx");
    });

    it("uses direct file_name from args when filePath is empty", () => {
      const props = makeUniversalProps({
        args: { file_name: "DirectName.ts" },
      });
      expect(extractFileData(props).fileName).toBe("DirectName.ts");
    });

    it("uses direct file_name from successData when filePath is empty", () => {
      const props = makeUniversalProps({
        result: { output: { success: { file_name: "SuccessName.ts" } } },
      });
      expect(extractFileData(props).fileName).toBe("SuccessName.ts");
    });

    it("returns empty string when no path and no direct name", () => {
      const props = makeUniversalProps({ args: {}, result: {} });
      expect(extractFileData(props).fileName).toBe("");
    });

    it("filePath-derived name takes priority over direct file_name", () => {
      const props = makeUniversalProps({
        args: { file_path: "src/FromPath.ts", file_name: "DirectName.ts" },
      });
      expect(extractFileData(props).fileName).toBe("FromPath.ts");
    });
  });

  describe("content extraction", () => {
    it("extracts content from successData.content", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { content: "file content here", path: "a.ts" } },
        },
      });
      expect(extractFileData(props).content).toBe("file content here");
    });

    it("extracts content from result.output via safeText", () => {
      const props = makeUniversalProps({
        result: { output: "plain output text" },
      });
      expect(extractFileData(props).content).toBe("plain output text");
    });

    it("extracts content from result.observation", () => {
      const props = makeUniversalProps({
        result: { observation: "observed content" },
      });
      expect(extractFileData(props).content).toBe("observed content");
    });

    it("returns undefined content when no source available", () => {
      const props = makeUniversalProps({ args: {}, result: {} });
      expect(extractFileData(props).content).toBeUndefined();
    });
  });

  describe("line number prefix stripping", () => {
    it("strips current `│` line number prefixes (e.g. '     1│content')", () => {
      const contentWithPrefixes =
        "     1│import React from 'react';\n     2│\n     3│export default App;";
      const props = makeUniversalProps({
        args: { file_path: "App.tsx" },
        result: {
          output: { success: { content: contentWithPrefixes } },
        },
      });
      const data = extractFileData(props);
      expect(data.content).toBe(
        "import React from 'react';\n\nexport default App;"
      );
      expect(data.lineCount).toBe(3);
    });

    it("strips legacy `→` line number prefixes", () => {
      const contentWithPrefixes =
        "  1→import React from 'react';\n  2→\n  3→export default App;";
      const props = makeUniversalProps({
        args: { file_path: "App.tsx" },
        result: {
          output: { success: { content: contentWithPrefixes } },
        },
      });
      const data = extractFileData(props);
      expect(data.content).toBe(
        "import React from 'react';\n\nexport default App;"
      );
      expect(data.lineCount).toBe(3);
    });

    it("strips the leading `[action: read_text]` marker plus line numbers", () => {
      // This is the exact shape `read_file` writes to `result.content`
      // (see agent_core/.../coding/files.rs::classify_read_action).
      const rawContent =
        "[action: read_text]\n     1│/**\n     2│ * useServiceAuth Hook\n     3│ */";
      const props = makeUniversalProps({
        args: { file_path: "useServiceAuth.ts" },
        result: { content: rawContent },
      });
      const data = extractFileData(props);
      expect(data.content).toBe("/**\n * useServiceAuth Hook\n */");
      expect(data.lineCount).toBe(3);
    });

    it("strips the action marker even when body has no line numbers", () => {
      const rawContent =
        "[action: read_image]\nImage: foo.png (image/png, 12kb)";
      const props = makeUniversalProps({
        args: { file_path: "foo.png" },
        result: { content: rawContent },
      });
      const data = extractFileData(props);
      expect(data.content).toBe("Image: foo.png (image/png, 12kb)");
    });

    it("strips read_file pagination footer from numbered content", () => {
      const rawContent =
        "[action: read_text]\n     1│const x = 1;\n     2│export default x;\n\n[Showing lines 1-2 of 10 total (1.2 KB). Use offset and limit to read other sections.]";
      const props = makeUniversalProps({
        args: { file_path: "x.ts" },
        result: { content: rawContent },
      });
      const data = extractFileData(props);
      expect(data.content).toBe("const x = 1;\nexport default x;\n");
      expect(data.lineCount).toBe(3);
      expect(data.startLine).toBe(1);
    });

    it("strips read_file pagination footer from rust-extracted content", () => {
      const props = makeUniversalProps({
        rustExtracted: {
          kind: "file",
          filePath: "x.ts",
          fileName: "x.ts",
          content:
            "     5│const x = 1;\n     6│export default x;\n\n[Showing lines 5-6 of 10 total (1.2 KB). Use offset and limit to read other sections.]",
          language: "typescript",
        },
      });
      const data = extractFileData(props);
      expect(data.content).toBe("const x = 1;\nexport default x;\n");
      expect(data.lineCount).toBe(3);
      expect(data.startLine).toBe(5);
    });

    it("strips read_file pagination footer without offset hint", () => {
      const rawContent =
        "line one\nline two\n[Showing lines 1-2 of 10 total (1.2 KB)]";
      const props = makeUniversalProps({
        args: { file_path: "notes.txt" },
        result: { content: rawContent },
      });
      const data = extractFileData(props);
      expect(data.content).toBe("line one\nline two");
      expect(data.lineCount).toBe(2);
    });

    it("does not strip content without line prefixes", () => {
      const plainContent = "const x = 1;\nconst y = 2;";
      const props = makeUniversalProps({
        args: { file_path: "plain.ts" },
        result: { output: { success: { content: plainContent } } },
      });
      const data = extractFileData(props);
      expect(data.content).toBe(plainContent);
      expect(data.lineCount).toBe(2);
      expect(data.startLine).toBeUndefined();
    });

    it("reports startLine for ranged reads (offset/limit)", () => {
      const rangedContent = "[action: read_text]\n   120│fn main() {\n   121│}";
      const props = makeUniversalProps({
        args: { file_path: "main.rs" },
        result: { content: rangedContent },
      });
      const data = extractFileData(props);
      expect(data.content).toBe("fn main() {\n}");
      expect(data.startLine).toBe(120);
    });

    it("reports startLine 1 for reads from the top", () => {
      const props = makeUniversalProps({
        args: { file_path: "top.ts" },
        result: { content: "     1│a\n     2│b" },
      });
      expect(extractFileData(props).startLine).toBe(1);
    });
  });

  describe("language detection", () => {
    it("detects typescript from .ts", () => {
      const props = makeUniversalProps({
        args: { file_path: "src/index.ts" },
      });
      expect(extractFileData(props).language).toBe("typescript");
    });

    it("detects typescript from .tsx", () => {
      const props = makeUniversalProps({
        args: { file_path: "src/App.tsx" },
      });
      expect(extractFileData(props).language).toBe("typescript");
    });

    it("detects python from .py", () => {
      const props = makeUniversalProps({
        args: { file_path: "main.py" },
      });
      expect(extractFileData(props).language).toBe("python");
    });

    it("detects rust from .rs", () => {
      const props = makeUniversalProps({
        args: { file_path: "lib.rs" },
      });
      expect(extractFileData(props).language).toBe("rust");
    });

    it("detects javascript from .js", () => {
      const props = makeUniversalProps({
        args: { file_path: "script.js" },
      });
      expect(extractFileData(props).language).toBe("javascript");
    });

    it("detects yaml from .yml", () => {
      const props = makeUniversalProps({
        args: { file_path: "config.yml" },
      });
      expect(extractFileData(props).language).toBe("yaml");
    });

    it("detects bash from .sh", () => {
      const props = makeUniversalProps({
        args: { file_path: "deploy.sh" },
      });
      expect(extractFileData(props).language).toBe("bash");
    });

    it("returns plaintext for unknown extensions", () => {
      const props = makeUniversalProps({
        args: { file_path: "data.xyz" },
      });
      expect(extractFileData(props).language).toBe("plaintext");
    });

    it("returns plaintext when no file name available", () => {
      const props = makeUniversalProps({ args: {}, result: {} });
      expect(extractFileData(props).language).toBe("plaintext");
    });
  });
});

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

// ============================================
// extractShellData
// ============================================

describe("extractShellData", () => {
  describe("command extraction", () => {
    it("extracts command from successData", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { command: "npm test" } },
        },
      });
      expect(extractShellData(props).command).toBe("npm test");
    });

    it("extracts command from args.command as fallback", () => {
      const props = makeUniversalProps({
        args: { command: "npm install" },
      });
      expect(extractShellData(props).command).toBe("npm install");
    });

    it("extracts command from result.command as last fallback", () => {
      const props = makeUniversalProps({
        result: { command: "git status" },
      });
      expect(extractShellData(props).command).toBe("git status");
    });

    it("returns empty string when no command found", () => {
      const props = makeUniversalProps({ args: {}, result: {} });
      expect(extractShellData(props).command).toBe("");
    });
  });

  describe("description extraction", () => {
    it("extracts description from args", () => {
      const props = makeUniversalProps({
        args: { command: "npm test", description: "Run unit tests" },
      });
      expect(extractShellData(props).description).toBe("Run unit tests");
    });

    it("returns undefined when no description", () => {
      const props = makeUniversalProps({ args: { command: "ls" } });
      expect(extractShellData(props).description).toBeUndefined();
    });
  });

  describe("output priority", () => {
    it("interleavedOutput has highest priority", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              interleavedOutput: "interleaved",
              stdout: "stdout text",
              stderr: "stderr text",
              command: "cmd",
            },
          },
        },
      });
      expect(extractShellData(props).output).toBe("interleaved");
    });

    it("stdout is next priority after interleavedOutput", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              stdout: "stdout text",
              stderr: "stderr text",
              command: "cmd",
            },
          },
        },
      });
      expect(extractShellData(props).output).toBe("stdout text");
    });

    it("stderr is next fallback", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              stderr: "error output",
              command: "cmd",
            },
          },
        },
      });
      expect(extractShellData(props).output).toBe("error output");
    });

    it("streamOutput from args is next fallback", () => {
      const props = makeUniversalProps({
        args: { command: "npm build", streamOutput: "Building..." },
      });
      expect(extractShellData(props).output).toBe("Building...");
    });

    it("result.output (via safeText) is next fallback", () => {
      const props = makeUniversalProps({
        args: { command: "echo hi" },
        result: { output: "direct output string" },
      });
      expect(extractShellData(props).output).toBe("direct output string");
    });

    it("result.observation is last fallback", () => {
      const props = makeUniversalProps({
        args: { command: "echo hi" },
        result: { observation: "observed output" },
      });
      expect(extractShellData(props).output).toBe("observed output");
    });

    it("returns undefined when no output source available", () => {
      const props = makeUniversalProps({
        args: { command: "noop" },
        result: {},
      });
      expect(extractShellData(props).output).toBeUndefined();
    });
  });

  describe("exitCode extraction", () => {
    it("extracts camelCase exitCode from success data", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { command: "ls", exitCode: 0 } },
        },
      });
      expect(extractShellData(props).exitCode).toBe(0);
    });

    it("extracts snake_case exit_code from success data", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { command: "ls", exit_code: 127 } },
        },
      });
      expect(extractShellData(props).exitCode).toBe(127);
    });

    it("extracts exit_code from result directly", () => {
      const props = makeUniversalProps({
        args: { command: "ls" },
        result: { exit_code: 1 },
      });
      expect(extractShellData(props).exitCode).toBe(1);
    });

    it("returns undefined when no exit code", () => {
      const props = makeUniversalProps({
        args: { command: "ls" },
        result: {},
      });
      expect(extractShellData(props).exitCode).toBeUndefined();
    });
  });

  describe("executionTime extraction", () => {
    it("extracts executionTime from success data (camelCase)", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: { command: "test", executionTime: 1234 },
          },
        },
      });
      expect(extractShellData(props).executionTime).toBe(1234);
    });

    it("extracts execution_time from success data (snake_case)", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: { command: "test", execution_time: 5678 },
          },
        },
      });
      expect(extractShellData(props).executionTime).toBe(5678);
    });
  });

  describe("cwd extraction", () => {
    it("extracts cwd from args", () => {
      const props = makeUniversalProps({
        args: { command: "ls", cwd: "/project/src" },
      });
      expect(extractShellData(props).cwd).toBe("/project/src");
    });

    it("returns undefined when no cwd", () => {
      const props = makeUniversalProps({ args: { command: "ls" } });
      expect(extractShellData(props).cwd).toBeUndefined();
    });
  });

  describe("isFailure flag", () => {
    it("isFailure is true when only failure data present (no success)", () => {
      const props = makeUniversalProps({
        args: { command: "bad-cmd" },
        result: {
          output: {
            failure: { error: "command not found", command: "bad-cmd" },
          },
        },
      });
      expect(extractShellData(props).isFailure).toBe(true);
    });

    it("isFailure is false when success data present", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { command: "ls", exitCode: 0 } },
        },
      });
      expect(extractShellData(props).isFailure).toBe(false);
    });

    it("isFailure is false when neither success nor failure present", () => {
      const props = makeUniversalProps({
        args: { command: "ls" },
        result: {},
      });
      expect(extractShellData(props).isFailure).toBe(false);
    });
  });

  describe("shell process state", () => {
    it("top-level shell process state overrides stale Rust-extracted state", () => {
      const props = makeUniversalProps({
        rustExtracted: {
          kind: "shell",
          command: "npm start",
          isFailure: false,
          shellPid: 11111,
          shellProcessStatus: "running",
          shellLogPath: "/tmp/old-shell.log",
        },
        shellPid: 22222,
        shellProcessStatus: "background",
        shellLogPath: "/tmp/background-shell.log",
      });
      const data = extractShellData(props);
      expect(data.shellPid).toBe(22222);
      expect(data.shellProcessStatus).toBe("background");
      expect(data.shellLogPath).toBe("/tmp/background-shell.log");
    });

    it("extracts shellPid, shellProcessStatus, shellLogPath from args", () => {
      const props = makeUniversalProps({
        args: {
          command: "npm start",
          shellPid: 12345,
          shellProcessStatus: "running",
          shellLogPath: "/tmp/shell.log",
        },
      });
      const data = extractShellData(props);
      expect(data.shellPid).toBe(12345);
      expect(data.shellProcessStatus).toBe("running");
      expect(data.shellLogPath).toBe("/tmp/shell.log");
    });

    it("extracts top-level normalized shell process state", () => {
      const props = makeUniversalProps({
        args: { command: "npm start" },
        shellPid: 12345,
        shellProcessStatus: "background",
        shellLogPath: "/tmp/shell.log",
      });
      const data = extractShellData(props);
      expect(data.shellPid).toBe(12345);
      expect(data.shellProcessStatus).toBe("background");
      expect(data.shellLogPath).toBe("/tmp/shell.log");
    });

    it("extracts snake-case shell process state from args", () => {
      const props = makeUniversalProps({
        args: {
          command: "npm start",
          shell_pid: 12345,
          shell_process_status: "running",
          shell_log_path: "/tmp/shell.log",
        },
      });
      const data = extractShellData(props);
      expect(data.shellPid).toBe(12345);
      expect(data.shellProcessStatus).toBe("running");
      expect(data.shellLogPath).toBe("/tmp/shell.log");
    });

    it("returns undefined for shell process state when not present", () => {
      const props = makeUniversalProps({ args: { command: "ls" } });
      const data = extractShellData(props);
      expect(data.shellPid).toBeUndefined();
      expect(data.shellProcessStatus).toBeUndefined();
      expect(data.shellLogPath).toBeUndefined();
    });
  });

  describe("streamOutput", () => {
    it("returns streamOutput separately from output", () => {
      const props = makeUniversalProps({
        args: {
          command: "npm build",
          streamOutput: "Compiling...",
        },
      });
      const data = extractShellData(props);
      expect(data.streamOutput).toBe("Compiling...");
      expect(data.output).toBe("Compiling...");
    });

    it("streamOutput is undefined when args.streamOutput is absent", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { command: "ls", stdout: "files" } },
        },
      });
      expect(extractShellData(props).streamOutput).toBeUndefined();
    });
  });
});

// ============================================
// extractSearchData
// ============================================

describe("extractSearchData", () => {
  describe("query extraction from various arg keys", () => {
    it("extracts from args.query", () => {
      const props = makeUniversalProps({ args: { query: "handleSubmit" } });
      expect(extractSearchData(props).query).toBe("handleSubmit");
    });

    it("extracts from args.pattern", () => {
      const props = makeUniversalProps({ args: { pattern: "foo.*bar" } });
      expect(extractSearchData(props).query).toBe("foo.*bar");
    });

    it("extracts from args.search_query", () => {
      const props = makeUniversalProps({
        args: { search_query: "authentication" },
      });
      expect(extractSearchData(props).query).toBe("authentication");
    });

    it("extracts from args.regex", () => {
      const props = makeUniversalProps({ args: { regex: "^import" } });
      expect(extractSearchData(props).query).toBe("^import");
    });

    it("extracts from args.search_term", () => {
      const props = makeUniversalProps({
        args: { search_term: "react hooks" },
      });
      expect(extractSearchData(props).query).toBe("react hooks");
    });

    it("extracts from args.searchTerm (camelCase)", () => {
      const props = makeUniversalProps({
        args: { searchTerm: "camelQuery" },
      });
      expect(extractSearchData(props).query).toBe("camelQuery");
    });

    it("extracts from args.text", () => {
      const props = makeUniversalProps({ args: { text: "search text" } });
      expect(extractSearchData(props).query).toBe("search text");
    });

    it("extracts from args.input", () => {
      const props = makeUniversalProps({ args: { input: "input query" } });
      expect(extractSearchData(props).query).toBe("input query");
    });

    it("returns empty string when no query source found", () => {
      const props = makeUniversalProps({ args: {} });
      expect(extractSearchData(props).query).toBe("");
    });

    it("args.query takes priority over args.pattern", () => {
      const props = makeUniversalProps({
        args: { query: "primary", pattern: "secondary" },
      });
      expect(extractSearchData(props).query).toBe("primary");
    });
  });

  describe("matches parsing", () => {
    it("parses result.matches array into structured results", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {
          matches: [
            { file: "src/a.ts", line: 10, content: "test function" },
            { file: "src/b.ts", line: 20, content: "another test" },
          ],
          total: 2,
        },
      });
      const data = extractSearchData(props);
      expect(data.results).toHaveLength(2);
      expect(data.results![0]).toEqual({
        file: "src/a.ts",
        line: 10,
        content: "test function",
      });
      expect(data.results![1]).toEqual({
        file: "src/b.ts",
        line: 20,
        content: "another test",
      });
    });

    it("returns empty array when result.matches is not an array", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: { matches: "not an array" },
      });
      expect(extractSearchData(props).results).toEqual([]);
    });

    it("returns empty array when result.matches is undefined", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {},
      });
      expect(extractSearchData(props).results).toEqual([]);
    });

    it("falls back to ripgrep text when rustExtracted search is empty", () => {
      const props = makeUniversalProps({
        args: { pattern: "require\\('../../src/database" },
        rustExtracted: {
          kind: "search",
          query: "require\\('../../src/database",
          results: [],
          totalMatches: 77,
        },
        result: {
          content:
            "/repo/test/mocks/databasemock.js-128-\n" +
            "/repo/test/mocks/databasemock.js:129:const db = require('../../src/database');",
        },
      });
      const data = extractSearchData(props);
      expect(data.results).toEqual([
        {
          file: "/repo/test/mocks/databasemock.js",
          line: 129,
          content: "const db = require('../../src/database');",
        },
      ]);
      expect(data.totalMatches).toBe(1);
    });
  });

  describe("totalMatches", () => {
    it("uses result.total when available", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {
          matches: [{ file: "a.ts", line: 1, content: "x" }],
          total: 50,
        },
      });
      expect(extractSearchData(props).totalMatches).toBe(50);
    });

    it("falls back to results.length when no total", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {
          matches: [
            { file: "a.ts", line: 1, content: "x" },
            { file: "b.ts", line: 2, content: "y" },
          ],
        },
      });
      expect(extractSearchData(props).totalMatches).toBe(2);
    });

    it("parses totalMatches from text summary regex", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {
          content: "Found 9 matches in 4 files",
        },
      });
      expect(extractSearchData(props).totalMatches).toBe(9);
    });

    it("parses totalMatches from plain digit+match format", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {
          content: "42 matches found across the codebase",
        },
      });
      expect(extractSearchData(props).totalMatches).toBe(42);
    });

    it("returns 0 when no matches and no summary text", () => {
      const props = makeUniversalProps({
        args: { query: "noresults" },
        result: { content: "No results found" },
      });
      expect(extractSearchData(props).totalMatches).toBe(0);
    });
  });
});

// ============================================
// extractTodoData
// ============================================

describe("extractTodoData", () => {
  describe("from result.observation as Python dict string", () => {
    it("parses Python dict with success.todos", () => {
      const props = makeUniversalProps({
        result: {
          observation:
            "{'success': {'todos': [{'id': 'todo-1', 'content': 'Implement feature', 'status': 'in_progress'}, {'id': 'todo-2', 'content': 'Write tests', 'status': 'pending'}], 'wasMerge': True}}",
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(2);
      expect(data.todos[0]).toEqual({
        id: "todo-1",
        content: "Implement feature",
        status: "in_progress",
      });
      expect(data.todos[1]).toEqual({
        id: "todo-2",
        content: "Write tests",
        status: "pending",
      });
      expect(data.wasMerge).toBe(true);
    });

    it("parses Python dict with direct todos (no success wrapper)", () => {
      const props = makeUniversalProps({
        result: {
          observation:
            "{'todos': [{'id': 't1', 'content': 'Task A', 'status': 'completed'}]}",
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].id).toBe("t1");
    });
  });

  describe("from result.observation as object", () => {
    it("extracts from observation object with success.todos", () => {
      const props = makeUniversalProps({
        result: {
          observation: {
            success: {
              todos: [
                { id: "obj-1", content: "Object task", status: "pending" },
              ],
              wasMerge: true,
            },
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].content).toBe("Object task");
      expect(data.wasMerge).toBe(true);
    });

    it("extracts from observation object with direct todos", () => {
      const props = makeUniversalProps({
        result: {
          observation: {
            todos: [
              { id: "direct-1", content: "Direct task", status: "pending" },
            ],
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].content).toBe("Direct task");
    });
  });

  describe("from args.todos (running events)", () => {
    it("extracts todos from args", () => {
      const props = makeUniversalProps({
        args: {
          todos: [
            { id: "a1", content: "Args task one", status: "in_progress" },
            { id: "a2", content: "Args task two", status: "pending" },
          ],
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(2);
      expect(data.todos[0].content).toBe("Args task one");
      expect(data.todos[1].content).toBe("Args task two");
    });
  });

  describe("from result.output.success.todos", () => {
    it("extracts from nested output success", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              todos: [
                { id: "s1", content: "Success task", status: "completed" },
              ],
            },
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].status).toBe("completed");
    });
  });

  describe("from result.todos (direct)", () => {
    it("extracts from result.todos directly", () => {
      const props = makeUniversalProps({
        result: {
          todos: [{ id: "r1", content: "Result task", status: "pending" }],
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].id).toBe("r1");
    });
  });

  describe("wasMerge flag", () => {
    it("extracts wasMerge from success data in observation", () => {
      const props = makeUniversalProps({
        result: {
          observation: {
            success: {
              todos: [{ id: "m1", content: "task", status: "pending" }],
              wasMerge: true,
            },
          },
        },
      });
      expect(extractTodoData(props).wasMerge).toBe(true);
    });

    it("extracts wasMerge from result.output.success", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              todos: [{ id: "m2", content: "task", status: "pending" }],
              wasMerge: true,
            },
          },
        },
      });
      expect(extractTodoData(props).wasMerge).toBe(true);
    });

    it("extracts wasMerge from result.success", () => {
      const props = makeUniversalProps({
        result: {
          success: {
            todos: [{ id: "m3", content: "task", status: "pending" }],
            wasMerge: true,
          },
        },
      });
      expect(extractTodoData(props).wasMerge).toBe(true);
    });

    it("extracts wasMerge from result directly", () => {
      const props = makeUniversalProps({
        result: {
          todos: [{ id: "m4", content: "task", status: "pending" }],
          wasMerge: true,
        },
      });
      expect(extractTodoData(props).wasMerge).toBe(true);
    });

    it("defaults to false when wasMerge not present", () => {
      const props = makeUniversalProps({
        result: {
          todos: [{ id: "m5", content: "task", status: "pending" }],
        },
      });
      expect(extractTodoData(props).wasMerge).toBe(false);
    });
  });

  describe("JSON string todos", () => {
    it("parses todos from JSON string", () => {
      const todosJson = JSON.stringify([
        { id: "j1", content: "JSON task", status: "pending" },
      ]);
      const props = makeUniversalProps({
        result: { todos: todosJson },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].content).toBe("JSON task");
    });

    it("returns empty array for invalid JSON string", () => {
      const props = makeUniversalProps({
        result: { todos: "not valid json {{{" },
      });
      expect(extractTodoData(props).todos).toEqual([]);
    });
  });

  describe("Gemini format (description field)", () => {
    it("maps description to content", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              todos: [
                { id: "g1", description: "Gemini task one", status: "pending" },
                {
                  id: "g2",
                  description: "Gemini task two",
                  status: "completed",
                },
              ],
            },
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos[0].content).toBe("Gemini task one");
      expect(data.todos[1].content).toBe("Gemini task two");
    });

    it("prefers content over description when both present", () => {
      const props = makeUniversalProps({
        result: {
          todos: [
            {
              id: "g3",
              content: "preferred",
              description: "fallback",
              status: "pending",
            },
          ],
        },
      });
      expect(extractTodoData(props).todos[0].content).toBe("preferred");
    });
  });

  describe("empty/invalid cases", () => {
    it("returns empty array for empty result", () => {
      const props = makeUniversalProps({ args: {}, result: {} });
      expect(extractTodoData(props).todos).toEqual([]);
    });

    it("returns empty array when todos is not an array", () => {
      const props = makeUniversalProps({
        result: { todos: { not: "array" } },
      });
      expect(extractTodoData(props).todos).toEqual([]);
    });

    it("returns empty array when todos is null", () => {
      const props = makeUniversalProps({
        result: { todos: null },
      });
      expect(extractTodoData(props).todos).toEqual([]);
    });

    it("defaults missing fields in todo items", () => {
      const props = makeUniversalProps({
        result: {
          todos: [{ id: "partial" }],
        },
      });
      const data = extractTodoData(props);
      expect(data.todos[0]).toEqual({
        id: "partial",
        content: "",
        status: "pending",
      });
    });

    it("defaults id to empty string when missing", () => {
      const props = makeUniversalProps({
        result: {
          todos: [{ content: "no id", status: "completed" }],
        },
      });
      expect(extractTodoData(props).todos[0].id).toBe("");
    });
  });

  describe("observation priority over fallback sources", () => {
    it("observation todos take priority over args.todos", () => {
      const props = makeUniversalProps({
        args: {
          todos: [{ id: "args-1", content: "from args", status: "pending" }],
        },
        result: {
          observation: {
            success: {
              todos: [
                { id: "obs-1", content: "from observation", status: "pending" },
              ],
            },
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].content).toBe("from observation");
    });
  });

  describe("native ORGII content-text snapshot (regression: simulator '0 items')", () => {
    const nativeContent = [
      "Updated todo #1 — 2 todos (1 remaining)",
      JSON.stringify(
        [
          {
            activeForm: "Fixing bug",
            content: "Fix bug",
            index: 0,
            priority: "high",
            status: "completed",
          },
          {
            activeForm: null,
            blockedBy: [0],
            content: "Write tests",
            index: 1,
            priority: "medium",
            status: "in_progress",
          },
        ],
        null,
        2
      ),
      "",
      "Ensure that you continue to use the todo list to track your progress.",
    ].join("\n");

    it("parses todos from result.content text for update events (no args.todos)", () => {
      const props = makeUniversalProps({
        args: { action: "update", index: 1, status: "in_progress" },
        result: { content: nativeContent },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(2);
      expect(data.todos[0].id).toBe("0");
      expect(data.todos[0].content).toBe("Fix bug");
      expect(data.todos[0].activeForm).toBe("Fixing bug");
      expect(data.todos[1].status).toBe("in_progress");
      expect(data.todos[1].blockedBy).toEqual([0]);
      expect(data.todos[1].activeForm).toBeUndefined();
    });

    it("returns empty for 'No todos for this session.' text", () => {
      const props = makeUniversalProps({
        args: { action: "read" },
        result: { content: "No todos for this session." },
      });
      expect(extractTodoData(props).todos).toEqual([]);
    });
  });

  describe("structured uiMetadata (dual-track response)", () => {
    it("prefers uiMetadata.data.todos over text parsing", () => {
      const props = makeUniversalProps({
        args: { action: "update", index: 0 },
        result: {
          content: "garbled text without parseable snapshot",
          uiMetadata: {
            display_type: "todo_list",
            data: {
              todos: [
                {
                  index: 0,
                  content: "Ship feature",
                  status: "in_progress",
                  activeForm: "Shipping feature",
                },
              ],
            },
            summary: "Updated todo #0 — 1 todos (1 remaining)",
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].id).toBe("0");
      expect(data.todos[0].content).toBe("Ship feature");
      expect(data.todos[0].activeForm).toBe("Shipping feature");
    });

    it("ignores uiMetadata with a different display_type", () => {
      const props = makeUniversalProps({
        result: {
          uiMetadata: { display_type: "search_results", data: { todos: [] } },
          todos: [{ id: "r1", content: "Result task", status: "pending" }],
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].id).toBe("r1");
    });
  });

  describe("rustExtracted short-circuit", () => {
    it("uses non-empty rustExtracted todos directly", () => {
      const props = makeUniversalProps({
        result: { content: "ignored" },
        rustExtracted: {
          kind: "todo",
          todos: [{ id: "rx-1", content: "Rust row", status: "pending" }],
          wasMerge: true,
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].id).toBe("rx-1");
      expect(data.wasMerge).toBe(true);
    });

    it("EMPTY rustExtracted does NOT short-circuit — falls through to content text", () => {
      const props = makeUniversalProps({
        args: { action: "update", index: 0 },
        result: {
          content:
            'Updated todo #0 — 1 todos (1 remaining)\n[\n  {\n    "content": "Recovered row",\n    "index": 0,\n    "status": "pending"\n  }\n]',
        },
        rustExtracted: { kind: "todo", todos: [], wasMerge: false },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].content).toBe("Recovered row");
    });
  });
});

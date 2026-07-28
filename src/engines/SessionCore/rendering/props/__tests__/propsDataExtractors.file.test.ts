import { describe, expect, it } from "vitest";

import { extractFileData } from "../propsDataExtractors";
import { makeUniversalProps } from "./fixtures";

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

    it("uses imported offset/limit metadata for plain read output ranges", () => {
      const props = makeUniversalProps({
        args: {
          file_path: "src/app.rs",
          offset: 249,
          limit: 36,
        },
        result: { output: "plain imported sed output" },
      });
      const data = extractFileData(props);
      expect(data.content).toBe("plain imported sed output");
      expect(data.startLine).toBe(250);
      expect(data.lineCount).toBe(36);
    });

    it("lets offset/limit repair stale rust extracted read ranges", () => {
      const props = makeUniversalProps({
        args: {
          file_path: "src/app.rs",
          offset: 859,
          limit: 41,
        },
        rustExtracted: {
          kind: "file",
          filePath: "src/app.rs",
          fileName: "app.rs",
          content: "plain imported sed output",
          language: "rust",
          lineCount: 1,
        },
      });
      const data = extractFileData(props);
      expect(data.startLine).toBe(860);
      expect(data.lineCount).toBe(41);
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

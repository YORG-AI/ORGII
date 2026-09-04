import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TranscriptItem } from "../../lib/transcriptReducer";
import MobileFilePreview from "./MobileFilePreview";
import { mobileFileTargets } from "./mobileFileTool";

describe("mobile file tool projection", () => {
  it("preserves authoritative apply-patch target indexes and line numbers", () => {
    const item: TranscriptItem = {
      id: "edit-1",
      kind: "tool",
      text: "apply_patch",
      toolData: {
        kind: "edit",
        filePath: "unused.ts",
        fileName: "unused.ts",
        language: "typescript",
        isDeleted: false,
        applyPatchSegments: [
          {
            filePath: "src/a.ts",
            fileName: "a.ts",
            language: "typescript",
            newStartLine: 3,
            diff: "@@ -3 +3 @@\n-old\n+new",
            isDeleted: false,
            applyPatchSegments: [],
          },
          {
            filePath: "src/b.ts",
            fileName: "b.ts",
            language: "typescript",
            newStartLine: 9,
            newContent: "export const b = true;",
            isDeleted: false,
            applyPatchSegments: [],
          },
        ],
      },
    };

    expect(mobileFileTargets(item)).toEqual([
      expect.objectContaining({
        targetIndex: 0,
        filePath: "src/a.ts",
        line: 3,
      }),
      expect.objectContaining({
        targetIndex: 1,
        filePath: "src/b.ts",
        line: 9,
      }),
    ]);
  });

  it("renders source immediately with the shared Prism token container", () => {
    const html = renderToStaticMarkup(
      React.createElement(MobileFilePreview, {
        target: {
          targetIndex: 0,
          filePath: "src/example.ts",
          fileName: "example.ts",
          language: "typescript",
          line: 7,
          content: "const value = '<safe>';",
        },
      })
    );

    expect(html).toContain('data-mobile-file-preview="code"');
    expect(html).toContain('data-mobile-highlight-language="typescript"');
    expect(html).toContain('data-mobile-file-line="7"');
    expect(html).toContain("prism-html");
    expect(html).toContain("border-border-1");
    expect(html).toContain("bg-event-block");
    expect(html).toContain("chat-code");
    expect(html).toContain("px-3 py-1.5");
    expect(html).not.toContain("example.ts:7");
    expect(html).toContain("&lt;safe&gt;");
  });
});

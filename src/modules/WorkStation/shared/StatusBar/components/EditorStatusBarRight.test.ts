import type { TFunction } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EditorStatusBarRight } from "./EditorStatusBarRight";

const t = ((key: string) => key) as TFunction;

describe("EditorStatusBarRight", () => {
  // Regression guard from "hide file types in status bar" (#953). The
  // language-service dropdown that used to sit next to the file type was
  // removed when LSP became agent-only (see `.archive/README.md`), so this
  // now also asserts the status bar stays free of any LSP affordance.
  it("keeps file-type labels and LSP affordances out of the status bar", () => {
    const markup = renderToStaticMarkup(
      createElement(EditorStatusBarRight, {
        t,
        commitInfo: null,
        cursor: null,
        hasSelection: false,
        totalLines: 12,
      })
    );

    expect(markup).not.toContain(">TS<");
    expect(markup).not.toContain("TypeScript");
    expect(markup).not.toContain("LSP");
  });

  it("still renders the line count", () => {
    const markup = renderToStaticMarkup(
      createElement(EditorStatusBarRight, {
        t,
        commitInfo: null,
        cursor: null,
        hasSelection: false,
        totalLines: 12,
      })
    );

    expect(markup).toContain("workstation.nLines");
  });
});

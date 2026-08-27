import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { codeMirrorPrismTheme } from "@src/features/CodeMirror/themes/prism";

import { PrismLight } from "./prismLight";

describe("PrismLight", () => {
  it("normalizes editor language aliases through the canonical registry", () => {
    const html = renderToStaticMarkup(
      PrismLight({
        language: "typescriptreact",
        style: codeMirrorPrismTheme,
        children: 'const result: string = "formatted";',
      })
    );

    expect(html).toContain("--cm-syntax-keyword");
    expect(html).toContain("--cm-syntax-string");
  });
});

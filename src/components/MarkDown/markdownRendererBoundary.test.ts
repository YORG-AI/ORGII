import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SRC_ROOT,
  importersOfPackage,
  walkStaticImports,
} from "@src/test/staticImportGraph";

/**
 * Where the Markdown tree is allowed to have a lazy boundary.
 *
 * Session transcripts are the product. When the renderer sat behind
 * `React.lazy`, one unresolvable module inside its chunk replaced the text of
 * every agent message, plan, issue and pull-request body in the app with a
 * single error string — and `React.lazy` caches a rejected promise, so a
 * transient failure stayed broken until reload. The renderer is therefore a
 * static import: it cannot fail to arrive, and a missing dependency is a build
 * error instead of a runtime placeholder.
 *
 * What justified the chunk is the Prism grammar set, which only colours code.
 * That boundary moved down to the code fence, where the fallback is the same
 * code without colour. These tests pin both halves so the split cannot quietly
 * revert to "lazy renderer, eager grammars".
 */
const MARKDOWN_ENTRY = "components/MarkDown/index.tsx";
const HIGHLIGHTER_PACKAGES = ["react-syntax-highlighter", "refractor"];

const readSource = (relativePath: string): string =>
  readFileSync(path.join(SRC_ROOT, relativePath), "utf8");

describe("markdown renderer boundary", () => {
  const graph = walkStaticImports([MARKDOWN_ENTRY]);

  it("reaches the renderer implementation statically", () => {
    const impl = path.join(SRC_ROOT, "components/MarkDown/MarkDownImpl.tsx");
    expect(
      graph.files.has(impl),
      "MarkDownImpl must be statically imported — content must not depend on a chunk load"
    ).toBe(true);
    expect(graph.packages.has("react-markdown")).toBe(true);
  });

  it("keeps the Prism grammar set behind the code-fence boundary", () => {
    const present = HIGHLIGHTER_PACKAGES.filter((pkg) =>
      graph.packages.has(pkg)
    );
    const explanation = present.map(
      (pkg) => `${pkg}:\n    ${importersOfPackage(graph, pkg).join("\n    ")}`
    );
    expect(
      explanation,
      "the highlighter must stay behind the lazy MarkdownCodeHighlighter boundary"
    ).toEqual([]);
  });

  it("loads the highlighter through a dynamic import with a plain-code fallback", () => {
    const source = readSource("components/MarkDown/MarkdownCodeBlock.tsx");
    expect(source).toMatch(/lazy\(\s*\(\)\s*=>\s*\n?\s*import\(/);
    expect(source).toContain("./MarkdownCodeHighlighter");
    // The Suspense fallback and the error fallback must both be the code
    // itself, never a placeholder that drops it.
    expect(source).toContain("fallback={plainCode}");
  });
});

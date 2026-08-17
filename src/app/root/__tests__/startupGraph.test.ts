import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SRC_ROOT,
  importersOfPackage,
  reachableFilesMatching,
  walkStaticImports,
} from "@src/test/staticImportGraph";

/**
 * Startup-graph guards.
 *
 * Everything statically reachable from `src/index.tsx` and `src/App.tsx` is
 * parsed and evaluated before first paint (index.tsx synchronously, App.tsx
 * as the first async chunk). These tests pin the boundaries recovered in
 * docs/memory-audit-2026-08-16/ram-optimization-findings.md so a future
 * barrel re-export or "convenience" import cannot silently drag a heavy
 * library back into boot. If a package below genuinely becomes a boot-time
 * dependency, move it to the allow-list with a reason.
 */
describe("startup static import graph", () => {
  const graph = walkStaticImports(["index.tsx", "App.tsx"]);

  it("keeps heavy, feature-scoped packages out of the boot graph", () => {
    const forbidden = [
      // Terminal stack (~470 KB): only the Terminal panel needs it.
      "@xterm/xterm",
      "@xterm/addon-webgl",
      "@xterm/addon-fit",
      "@xterm/addon-search",
      "@xterm/addon-serialize",
      // CodeMirror editor stack (~1 MB with language packs).
      "@codemirror/view",
      "@codemirror/state",
      "@codemirror/language",
      "@codemirror/lang-javascript",
      "@codemirror/lang-python",
      "@codemirror/lang-rust",
      "@codemirror/lang-sql",
      "@codemirror/lang-markdown",
      "@uiw/react-codemirror",
      "@replit/codemirror-indentation-markers",
      "sql-formatter",
      // Highlighters other than the lazily-grammar'd shiki hook.
      "react-syntax-highlighter",
      "refractor",
      "highlight.js",
      // Animation / charts / document viewers.
      "framer-motion",
      "recharts",
      "mermaid",
      "mammoth",
      "jszip",
      "sucrase",
    ];
    const present = forbidden.filter((pkg) => graph.packages.has(pkg));
    const explanation = present.map(
      (pkg) => `${pkg}:\n    ${importersOfPackage(graph, pkg).join("\n    ")}`
    );
    expect(
      explanation,
      "heavy packages became statically reachable from the startup graph"
    ).toEqual([]);
  });

  it("does not statically reach the editor / terminal / diff feature trees", () => {
    const forbidden = reachableFilesMatching(
      graph,
      // Entry points that instantiate the heavy stacks (pure helpers such as
      // `features/CodeMirror/config/nonce.ts` or `TerminalInteractive/bufferCache.ts`
      // are fine to share).
      /^(features\/CodeMirror\/(index\.ts|Editor\/|Diff\/|SqlEditor\/|shared\/languageExtensions\.ts|config\/extensions\.ts)|components\/TerminalInteractive\/(index\.tsx|terminalSetup\.ts)|engines\/TerminalCore\/index\.tsx|scaffold\/ModalSystem\/variants\/ContentView\/)/
    );
    expect(
      forbidden.map((f) => graph.explain(f)),
      "feature trees leaked into the startup graph (each line is the import chain)"
    ).toEqual([]);
  });

  it("keeps the App entry import foldable so production emits an async App chunk", () => {
    // webpack only constant-folds a DefinePlugin expression when it appears
    // inline at the branch. `isDev ? import(/* eager */ …) : import(…)`
    // is walked on both arms and the "eager" mode wins → App inlined into
    // main.js (~4 MB of synchronous startup JS). Keep the inline form.
    const source = readFileSync(path.join(SRC_ROOT, "index.tsx"), "utf8");
    // The explanatory comment above the import mentions the magic comment
    // too, so anchor on the last occurrence (the real `import()` call).
    const eagerIndex = source.lastIndexOf('webpackMode: "eager"');
    expect(eagerIndex).toBeGreaterThan(-1);
    const window = source.slice(Math.max(0, eagerIndex - 400), eagerIndex);
    const conditionIndex = window.lastIndexOf(
      'process.env.NODE_ENV === "development"'
    );
    expect(
      conditionIndex,
      'the eager App import must be guarded by an inline `process.env.NODE_ENV === "development"` test'
    ).toBeGreaterThan(-1);
    const guardTail = window.slice(conditionIndex);
    expect(guardTail).not.toMatch(/\bisDev\b/);
  });
});

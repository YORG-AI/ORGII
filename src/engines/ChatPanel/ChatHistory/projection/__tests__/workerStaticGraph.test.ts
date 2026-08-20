import { describe, expect, it } from "vitest";

import {
  reachableFilesMatching,
  walkStaticImports,
} from "@src/test/staticImportGraph";

/**
 * Bundle-boundary guard for the chat-projection web worker.
 *
 * The worker is its own webpack entrypoint. Any dynamic `import()` reachable
 * from its *static* graph becomes part of the worker's chunk graph; because
 * the worker entry does not share the main app's `vendors` chunk, webpack
 * then has to copy every vendor module those chunks need (react-dom, xterm,
 * CodeMirror, zod, …) into the async chunks the main app also loads. When
 * `ActionRegistry` imported the registry barrel — which re-exports
 * `rendering/registry/events/index.ts` with its lazy renderer loaders — the
 * worker statically reached 2 388 files and the production build carried
 * ~9 MB of duplicated vendor code. See
 * docs/memory-audit-2026-08-16/ram-optimization-findings.md (Fix log, 2.3).
 */
describe("chat projection worker static import graph", () => {
  const graph = walkStaticImports([
    "engines/ChatPanel/ChatHistory/projection/worker.ts",
  ]);

  it("does not reach the React event renderer loaders", () => {
    const forbidden = reachableFilesMatching(
      graph,
      /^(engines\/SessionCore\/rendering\/registry\/events\/index\.tsx?|engines\/SessionCore\/rendering\/registry\/registryAccessors\.tsx?|engines\/ChatPanel\/events\/|engines\/ChatPanel\/rendering\/index\.tsx?)/
    );
    expect(
      forbidden.map((f) => graph.explain(f)),
      "worker graph reached renderer loaders (each line is the import chain)"
    ).toEqual([]);
  });

  it("does not depend on react-dom or the DOM-only libraries", () => {
    // `react` itself is tolerated (a ~10 KB core reached through the shared
    // logger hook); react-dom and the editor/terminal stacks are not.
    const heavy = [
      "react-dom",
      "@xterm/xterm",
      "@codemirror/view",
      "framer-motion",
      "lucide-react",
    ].filter((pkg) => graph.packages.has(pkg));
    expect(heavy, "worker graph pulled in UI packages").toEqual([]);
  });

  it("stays small (regression tripwire for barrel re-exports)", () => {
    // 39 files at the time of writing; the previous barrel import made it
    // 47 static + 2 388 with dynamic edges. Bump deliberately if the worker
    // genuinely needs more modules.
    expect(graph.files.size).toBeLessThanOrEqual(80);
  });
});

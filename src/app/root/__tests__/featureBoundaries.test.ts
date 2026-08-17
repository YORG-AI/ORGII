import { describe, expect, it } from "vitest";

import {
  importersOfPackage,
  walkStaticImports,
} from "@src/test/staticImportGraph";

/**
 * Heavy-feature boundary guards for lazily loaded surfaces.
 *
 * Each root below is its own async chunk (a route page, workstation app,
 * or event renderer). Before this guard existed, several of them statically
 * reached the editor/terminal/highlighter/chart stacks through barrel
 * re-exports (`modules/WorkStation/shared`, `features/CodeMirror`) or a
 * single eager import — e.g. the agent-message renderer (every chat) pulled
 * xterm, CodeMirror, react-syntax-highlighter, highlight.js, recharts,
 * mammoth and jszip. See docs/memory-audit-2026-08-16 (Fix log).
 *
 * If a surface genuinely needs one of these packages, load it behind a
 * `React.lazy` / dynamic `import()` at the point of use, or move the root
 * to the allow-list below with a reason.
 */
const EDITOR_STACK = [
  "@codemirror/view",
  "@codemirror/state",
  "@uiw/react-codemirror",
  "sql-formatter",
];
const TERMINAL_STACK = ["@xterm/xterm", "@xterm/addon-webgl"];
const HIGHLIGHTERS = ["react-syntax-highlighter", "refractor", "highlight.js"];
const MISC_HEAVY = [
  "framer-motion",
  "recharts",
  "mermaid",
  "mammoth",
  "jszip",
  "sucrase",
];

interface Boundary {
  root: string;
  forbidden: string[];
  reason: string;
}

const BOUNDARIES: Boundary[] = [
  {
    root: "engines/ChatPanel/events/stream/agent-message/index.tsx",
    forbidden: [
      ...EDITOR_STACK,
      ...TERMINAL_STACK,
      ...HIGHLIGHTERS,
      ...MISC_HEAVY,
    ],
    reason:
      "renders every agent message; simulator/canvas/code surfaces are lazy",
  },
  {
    root: "engines/ChatPanel/events/stream/user-message/index.tsx",
    forbidden: [
      ...EDITOR_STACK,
      ...TERMINAL_STACK,
      ...HIGHLIGHTERS,
      ...MISC_HEAVY,
    ],
    reason: "renders every user message",
  },
  {
    root: "modules/MainApp/TeamInbox/index.ts",
    forbidden: [
      ...EDITOR_STACK,
      ...TERMINAL_STACK,
      ...HIGHLIGHTERS,
      "framer-motion",
    ],
    reason: "inbox list/detail; no editor or terminal",
  },
  {
    root: "modules/MainApp/Settings/SettingsSlot.tsx",
    forbidden: [...EDITOR_STACK, ...TERMINAL_STACK, ...HIGHLIGHTERS],
    reason: "settings; the skill/policy editors load CodeMirror lazily",
  },
  {
    root: "modules/MainApp/AgentOrgs/index.tsx",
    forbidden: [...EDITOR_STACK, ...TERMINAL_STACK, ...HIGHLIGHTERS],
    reason: "agent orgs; MarkdownEditor loads CodeMirror lazily",
  },
  {
    root: "modules/ProjectManager/Projects/index.tsx",
    forbidden: [
      ...EDITOR_STACK,
      ...TERMINAL_STACK,
      ...HIGHLIGHTERS,
      "framer-motion",
    ],
    reason: "project manager pages",
  },
  {
    root: "modules/ProjectManager/WorkItems/index.tsx",
    forbidden: [
      ...EDITOR_STACK,
      ...TERMINAL_STACK,
      ...HIGHLIGHTERS,
      "framer-motion",
    ],
    reason: "project manager pages",
  },
  {
    root: "engines/Simulator/index.ts",
    forbidden: [...EDITOR_STACK, ...TERMINAL_STACK, ...HIGHLIGHTERS],
    reason: "simulator shell; individual apps lazy-load their editors",
  },
  {
    root: "modules/WorkStation/shared/index.ts",
    forbidden: [
      ...EDITOR_STACK,
      ...TERMINAL_STACK,
      ...HIGHLIGHTERS,
      "framer-motion",
    ],
    reason:
      "shared barrel imported by ~80 files; heavy components must not be re-exported here",
  },
];

describe("heavy-feature boundaries", () => {
  for (const boundary of BOUNDARIES) {
    it(`${boundary.root} stays free of heavy stacks (${boundary.reason})`, () => {
      const graph = walkStaticImports([boundary.root]);
      const present = boundary.forbidden.filter((pkg) =>
        graph.packages.has(pkg)
      );
      const explanation = present.map(
        (pkg) =>
          `${pkg}:\n    ${importersOfPackage(graph, pkg).slice(0, 3).join("\n    ")}`
      );
      expect(
        explanation,
        "heavy package reachable (import chains shown)"
      ).toEqual([]);
    });
  }
});

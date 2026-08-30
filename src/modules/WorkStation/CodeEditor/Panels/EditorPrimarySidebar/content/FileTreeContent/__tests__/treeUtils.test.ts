/** WorkStation file-tree utility coverage. */
import { describe, expect, it } from "vitest";

import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";

import type { FlattenedNode } from "../types";
import {
  findFileInNodes,
  flattenTree,
  getLookupPath,
} from "../utils/treeUtils";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeFile(path: string, name?: string): TreePanelNode {
  const parts = path.split("/");
  return {
    id: path,
    name: name ?? parts[parts.length - 1],
    path,
    type: "file",
    expanded: false,
  };
}

function makeDir(
  path: string,
  children: TreePanelNode[] = [],
  expanded = false
): TreePanelNode {
  const parts = path.split("/");
  return {
    id: path,
    name: parts[parts.length - 1],
    path,
    type: "directory",
    expanded,
    children,
  };
}

// ─── flattenTree ─────────────────────────────────────────────────────────────

describe("flattenTree", () => {
  it("returns empty array for empty input", () => {
    expect(flattenTree([])).toEqual([]);
  });

  it("returns flat files at depth 0", () => {
    const nodes = [makeFile("/a/foo.ts"), makeFile("/a/bar.ts")];
    const result = flattenTree(nodes);
    expect(result).toHaveLength(2);
    expect(result[0].depth).toBe(0);
    expect(result[1].depth).toBe(0);
  });

  it("does not recurse into collapsed directories", () => {
    const dir = makeDir("/a/src", [makeFile("/a/src/index.ts")], false);
    const result = flattenTree([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].node.path).toBe("/a/src");
  });

  it("recurses into expanded directories and sets depth correctly", () => {
    const dir = makeDir(
      "/a/src",
      [makeFile("/a/src/index.ts"), makeFile("/a/src/utils.ts")],
      true
    );
    const result = flattenTree([dir]);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ depth: 0, node: { path: "/a/src" } });
    expect(result[1]).toMatchObject({
      depth: 1,
      node: { path: "/a/src/index.ts" },
    });
    expect(result[2]).toMatchObject({
      depth: 1,
      node: { path: "/a/src/utils.ts" },
    });
  });

  it("handles multi-level nesting", () => {
    const nested = makeDir(
      "/a/src",
      [
        makeDir(
          "/a/src/components",
          [makeFile("/a/src/components/Button.tsx")],
          true
        ),
      ],
      true
    );
    const result = flattenTree([nested]);
    expect(result).toHaveLength(3);
    expect(result[0].depth).toBe(0);
    expect(result[1].depth).toBe(1);
    expect(result[2].depth).toBe(2);
  });

  it("handles a single file", () => {
    const result = flattenTree([makeFile("/x/file.ts")]);
    expect(result).toHaveLength(1);
  });

  it("preserves node identity", () => {
    const file = makeFile("/a/b.ts");
    const result = flattenTree([file]);
    expect(result[0].node).toBe(file);
  });
});

// ─── findFileInNodes ──────────────────────────────────────────────────────────

function makeFlattened(path: string): FlattenedNode {
  return { node: makeFile(path), depth: 0 };
}

describe("findFileInNodes", () => {
  it("returns -1 for empty nodes", () => {
    expect(findFileInNodes([], "/x/y.ts")).toBe(-1);
  });

  it("finds exact path match", () => {
    const nodes = [makeFlattened("/a/b.ts"), makeFlattened("/a/c.ts")];
    expect(findFileInNodes(nodes, "/a/b.ts")).toBe(0);
    expect(findFileInNodes(nodes, "/a/c.ts")).toBe(1);
  });

  it("returns -1 when path is not found", () => {
    const nodes = [makeFlattened("/a/b.ts")];
    expect(findFileInNodes(nodes, "/a/x.ts")).toBe(-1);
  });

  it("matches relative path via suffix", () => {
    const nodes = [makeFlattened("/repo/src/index.ts")];
    expect(findFileInNodes(nodes, "src/index.ts")).toBe(0);
  });

  it("matches when node path ends with / + targetPath", () => {
    const nodes = [makeFlattened("/repo/foo.ts")];
    expect(findFileInNodes(nodes, "foo.ts")).toBe(0);
  });

  it("does not false-positive on similar trailing segments", () => {
    const nodes = [makeFlattened("/a/bad/index.ts")];
    // targetPath ends with /index.ts but different parent
    expect(findFileInNodes(nodes, "/b/good/index.ts")).toBe(-1);
  });

  it("handles single-segment paths", () => {
    const nodes = [
      { node: { ...makeFile("README.md"), name: "README.md" }, depth: 0 },
    ];
    expect(findFileInNodes(nodes, "README.md")).toBe(0);
  });
});

// ─── getLookupPath ────────────────────────────────────────────────────────────

describe("getLookupPath", () => {
  const repoPath = "/home/user/project";

  it("returns nodePath as-is in multi-root mode", () => {
    expect(getLookupPath("/home/user/project/src/a.ts", repoPath, true)).toBe(
      "/home/user/project/src/a.ts"
    );
  });

  it("strips repoPath prefix in single-root mode", () => {
    expect(getLookupPath("/home/user/project/src/a.ts", repoPath, false)).toBe(
      "src/a.ts"
    );
  });

  it("returns nodePath unchanged when repoPath is null", () => {
    expect(getLookupPath("/home/user/project/src/a.ts", null, false)).toBe(
      "/home/user/project/src/a.ts"
    );
  });

  it("returns nodePath unchanged when path does not start with repoPath", () => {
    expect(getLookupPath("/other/repo/a.ts", repoPath, false)).toBe(
      "/other/repo/a.ts"
    );
  });

  it("handles empty nodePath", () => {
    expect(getLookupPath("", repoPath, false)).toBe("");
  });

  it("handles root-level file (path == repoPath + /file)", () => {
    expect(getLookupPath("/home/user/project/file.ts", repoPath, false)).toBe(
      "file.ts"
    );
  });
});

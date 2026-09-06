import { describe, expect, it } from "vitest";

import {
  carryRetainedExpansion,
  collectExpandedPaths,
  countTreeNodes,
  findNodeInTree,
  pruneCollapsedSubtree,
  updateTreeChildren,
  updateTreeExpansion,
} from "@src/modules/WorkStation/CodeEditor/hooks/useCodeEditor/helpers";
import type { FileNode } from "@src/store/workstation/codeEditor/file";

function file(path: string, name: string): FileNode {
  return { name, path, type: "file", expanded: false };
}

function dir(
  path: string,
  name: string,
  opts: { expanded?: boolean; children?: FileNode[] } = {}
): FileNode {
  return {
    name,
    path,
    type: "directory",
    expanded: opts.expanded ?? false,
    children: opts.children,
  };
}

describe("updateTreeExpansion", () => {
  it("sets expanded on a matching directory node", () => {
    const tree: FileNode[] = [
      dir("/repo/src", "src", {
        expanded: false,
        children: [file("/repo/src/a.ts", "a.ts")],
      }),
    ];
    const next = updateTreeExpansion(tree, "/repo/src", true);
    expect(next[0]?.expanded).toBe(true);
    expect(next[0]?.children?.[0]?.path).toBe("/repo/src/a.ts");
  });

  it("updates nested directories", () => {
    const tree: FileNode[] = [
      dir("/r", "r", {
        children: [dir("/r/nested", "nested", { expanded: false })],
      }),
    ];
    const next = updateTreeExpansion(tree, "/r/nested", true);
    const nested = next[0]?.children?.[0];
    expect(nested?.expanded).toBe(true);
  });

  it("does not change files or non-matching paths", () => {
    const tree: FileNode[] = [file("/repo/readme.md", "readme.md")];
    expect(updateTreeExpansion(tree, "/repo/readme.md", true)).toEqual(tree);
  });
});

describe("updateTreeChildren", () => {
  it("replaces children and expands the target directory", () => {
    const tree: FileNode[] = [
      dir("/repo/lib", "lib", {
        children: [file("/repo/lib/old.ts", "old.ts")],
      }),
    ];
    const newChildren = [file("/repo/lib/new.ts", "new.ts")];
    const next = updateTreeChildren(tree, "/repo/lib", newChildren);
    expect(next[0]?.expanded).toBe(true);
    expect(next[0]?.children).toEqual(newChildren);
  });

  it("updates nested paths recursively", () => {
    const tree: FileNode[] = [
      dir("/r", "r", {
        children: [dir("/r/pkg", "pkg", { children: [] })],
      }),
    ];
    const next = updateTreeChildren(tree, "/r/pkg", [
      file("/r/pkg/index.ts", "index.ts"),
    ]);
    expect(next[0]?.children?.[0]?.children).toHaveLength(1);
    expect(next[0]?.children?.[0]?.expanded).toBe(true);
  });
});

describe("findNodeInTree", () => {
  it("finds a node at root level", () => {
    const tree: FileNode[] = [
      file("/repo/readme.md", "readme.md"),
      dir("/repo/src", "src"),
    ];

    const found = findNodeInTree(tree, "/repo/readme.md");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("readme.md");
  });

  it("finds a nested node", () => {
    const tree: FileNode[] = [
      dir("/repo/src", "src", {
        children: [
          dir("/repo/src/components", "components", {
            children: [file("/repo/src/components/Button.tsx", "Button.tsx")],
          }),
        ],
      }),
    ];

    const found = findNodeInTree(tree, "/repo/src/components/Button.tsx");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Button.tsx");
  });

  it("returns null for non-existent path", () => {
    const tree: FileNode[] = [file("/repo/a.ts", "a.ts")];

    const found = findNodeInTree(tree, "/repo/nonexistent.ts");
    expect(found).toBeNull();
  });

  it("returns null for empty tree", () => {
    const found = findNodeInTree([], "/any/path");
    expect(found).toBeNull();
  });

  it("finds directory node", () => {
    const tree: FileNode[] = [
      dir("/repo/src", "src", {
        expanded: true,
        children: [file("/repo/src/index.ts", "index.ts")],
      }),
    ];

    const found = findNodeInTree(tree, "/repo/src");
    expect(found).not.toBeNull();
    expect(found?.type).toBe("directory");
    expect(found?.expanded).toBe(true);
  });
});

describe("pruneCollapsedSubtree", () => {
  function browsedTree(): FileNode[] {
    return [
      dir("/repo/src", "src", {
        expanded: false,
        children: [
          dir("/repo/src/a", "a", {
            expanded: true,
            children: [
              dir("/repo/src/a/deep", "deep", {
                expanded: true,
                children: [file("/repo/src/a/deep/x.ts", "x.ts")],
              }),
              dir("/repo/src/a/closed", "closed", {
                expanded: false,
                children: [file("/repo/src/a/closed/y.ts", "y.ts")],
              }),
            ],
          }),
          dir("/repo/src/b", "b", { expanded: false, children: [] }),
          file("/repo/src/index.ts", "index.ts"),
        ],
      }),
      dir("/repo/docs", "docs", {
        expanded: true,
        children: [file("/repo/docs/README.md", "README.md")],
      }),
    ];
  }

  it("drops a collapsed directory's children and remembers expanded descendants", () => {
    const next = pruneCollapsedSubtree(browsedTree(), "/repo/src");
    const src = next[0];
    expect(src?.children).toBeUndefined();
    expect(src?.expanded).toBe(false);
    expect(src?.retainedExpandedPaths).toEqual([
      "/repo/src/a",
      "/repo/src/a/deep",
    ]);
    // Siblings are untouched.
    expect(next[1]?.children?.[0]?.path).toBe("/repo/docs/README.md");
  });

  it("omits the memory when nothing underneath was expanded", () => {
    const tree: FileNode[] = [
      dir("/repo/lib", "lib", {
        expanded: false,
        children: [file("/repo/lib/z.ts", "z.ts")],
      }),
    ];
    const next = pruneCollapsedSubtree(tree, "/repo/lib");
    expect(next[0]?.children).toBeUndefined();
    expect(next[0]).not.toHaveProperty("retainedExpandedPaths");
  });

  it("never prunes an expanded directory, a file, or an unloaded directory", () => {
    const tree = browsedTree();
    expect(pruneCollapsedSubtree(tree, "/repo/docs")[1]?.children).toHaveLength(
      1
    );
    expect(pruneCollapsedSubtree(tree, "/repo/src/index.ts")).toEqual(tree);
    expect(pruneCollapsedSubtree(tree, "/repo/src/b")).toEqual(tree);
  });

  it("prunes nested targets in place", () => {
    const next = pruneCollapsedSubtree(browsedTree(), "/repo/src/a/closed");
    const closed = findNodeInTree(next, "/repo/src/a/closed");
    expect(closed?.children).toBeUndefined();
    expect(findNodeInTree(next, "/repo/src/a/deep")?.children).toHaveLength(1);
  });
});

describe("updateTreeChildren after pruning", () => {
  it("clears the remembered expansion once children are reloaded", () => {
    const pruned = pruneCollapsedSubtree(
      [
        dir("/repo/src", "src", {
          expanded: false,
          children: [
            dir("/repo/src/a", "a", {
              expanded: true,
              children: [file("/repo/src/a/x.ts", "x.ts")],
            }),
          ],
        }),
      ],
      "/repo/src"
    );
    expect(pruned[0]?.retainedExpandedPaths).toEqual(["/repo/src/a"]);
    const reloaded = updateTreeChildren(pruned, "/repo/src", [
      dir("/repo/src/a", "a", { expanded: true, children: [] }),
    ]);
    expect(reloaded[0]?.expanded).toBe(true);
    expect(reloaded[0]).not.toHaveProperty("retainedExpandedPaths");
    expect(reloaded[0]?.children?.[0]?.expanded).toBe(true);
  });
});

describe("carryRetainedExpansion", () => {
  it("copies remembered expansion onto a rebuilt tree", () => {
    const old = pruneCollapsedSubtree(
      [
        dir("/repo/src", "src", {
          expanded: false,
          children: [
            dir("/repo/src/a", "a", {
              expanded: true,
              children: [file("/repo/src/a/x.ts", "x.ts")],
            }),
          ],
        }),
      ],
      "/repo/src"
    );
    const rebuilt: FileNode[] = [
      dir("/repo/src", "src", { expanded: false, children: [] }),
      dir("/repo/new", "new", { expanded: false, children: [] }),
    ];
    const next = carryRetainedExpansion(rebuilt, old);
    expect(next[0]?.retainedExpandedPaths).toEqual(["/repo/src/a"]);
    expect(next[1]).not.toHaveProperty("retainedExpandedPaths");
  });

  it("does not override a directory the rebuild already loaded", () => {
    const old: FileNode[] = [
      { ...dir("/repo/src", "src"), retainedExpandedPaths: ["/repo/src/a"] },
    ];
    const rebuilt: FileNode[] = [
      dir("/repo/src", "src", {
        expanded: true,
        children: [file("/repo/src/i.ts", "i.ts")],
      }),
    ];
    const next = carryRetainedExpansion(rebuilt, old);
    expect(next[0]).not.toHaveProperty("retainedExpandedPaths");
    expect(next[0]?.children?.[0]?.path).toBe("/repo/src/i.ts");
  });

  it("returns the rebuilt tree as-is when nothing was remembered", () => {
    const rebuilt: FileNode[] = [dir("/repo/src", "src")];
    expect(carryRetainedExpansion(rebuilt, [dir("/repo/src", "src")])).toBe(
      rebuilt
    );
  });
});

describe("collectExpandedPaths / countTreeNodes", () => {
  it("lists expanded directories that have loaded children, depth first", () => {
    const tree: FileNode[] = [
      dir("/repo/src", "src", {
        expanded: true,
        children: [
          dir("/repo/src/a", "a", {
            expanded: true,
            children: [file("/repo/src/a/x.ts", "x.ts")],
          }),
          dir("/repo/src/empty", "empty", { expanded: true, children: [] }),
        ],
      }),
    ];
    expect(collectExpandedPaths(tree)).toEqual(["/repo/src", "/repo/src/a"]);
    expect(countTreeNodes(tree)).toBe(4);
  });
});

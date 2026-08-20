import { describe, expect, it } from "vitest";

import {
  findNodeInTree,
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

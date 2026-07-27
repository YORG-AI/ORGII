/**
 * Unit tests for simulator file tree build, filter, flatten, and counts.
 */
import { describe, expect, it } from "vitest";

import {
  type FileTreeInput,
  buildFileTree,
  countFileNodes,
  filterFileTree,
  flattenFileTree,
} from "../fileTreeUtils";

function leaf(
  id: string,
  filePath: string,
  fileName: string,
  overrides: Partial<FileTreeInput> = {}
): FileTreeInput {
  return { id, filePath, fileName, ...overrides };
}

describe("buildFileTree", () => {
  it("returns an empty array for no items", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("builds nested directories and a file leaf", () => {
    const tree = buildFileTree([
      leaf("e1", "src/components/Button.tsx", "Button.tsx"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe("directory");
    expect(tree[0].name).toBe("src/components");
    expect(tree[0].children).toHaveLength(1);
    const file = tree[0].children[0];
    expect(file.type).toBe("file");
    expect(file.name).toBe("Button.tsx");
    expect(file.path).toBe("src/components/Button.tsx");
  });

  it("uses logicalPath for the leaf path when provided", () => {
    const tree = buildFileTree([
      leaf("e1", "a/b/c.ts", "c.ts", { logicalPath: "/real/c.ts" }),
    ]);
    const file = tree[0].children[0];
    expect(file.path).toBe("/real/c.ts");
  });

  it("preserves the original file name and icon without legacy row metadata", () => {
    const legacyItem = {
      ...leaf("e1", "src/simulatorAtom.ts", "simulatorAtom.ts", {
        icon: "typescript-icon",
      }),
      secondaryInfo: "#9 · ui",
    };

    const tree = buildFileTree([legacyItem]);
    const file = tree[0].children[0];

    expect(file.name).toBe("simulatorAtom.ts");
    expect(file.icon).toBe("typescript-icon");
    expect(file).not.toHaveProperty("secondaryInfo");
  });

  it("sorts directories before files and names alphabetically", () => {
    const tree = buildFileTree([
      leaf("2", "z/z.ts", "z.ts"),
      leaf("1", "a/a.ts", "a.ts"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["a", "z"]);
  });

  it("places files under the same directory in one folder", () => {
    const tree = buildFileTree([
      leaf("a", "pkg/a.ts", "a.ts"),
      leaf("b", "pkg/b.ts", "b.ts"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("pkg");
    expect(tree[0].children.map((c) => c.name).sort()).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });
});

describe("filterFileTree", () => {
  const sample = buildFileTree([
    leaf("1", "src/foo.ts", "foo.ts"),
    leaf("2", "lib/bar.ts", "bar.ts"),
  ]);

  it("returns the original tree for an empty query", () => {
    expect(filterFileTree(sample, "")).toEqual(sample);
    expect(filterFileTree(sample, "   ")).toEqual(sample);
  });

  it("keeps files whose name matches case-insensitively", () => {
    const filtered = filterFileTree(sample, "FOO");
    expect(countFileNodes(filtered)).toBe(1);
    expect(filtered[0].children[0].name).toBe("foo.ts");
  });

  it("keeps ancestor directories when a nested file matches", () => {
    const tree = buildFileTree([leaf("1", "deep/nested/file.ts", "file.ts")]);
    const filtered = filterFileTree(tree, "nested");
    expect(countFileNodes(filtered)).toBe(1);
  });
});

describe("flattenFileTree", () => {
  it("marks directories expanded when not in collapsed set", () => {
    const tree = buildFileTree([leaf("1", "a/b.ts", "b.ts")]);
    const flat = flattenFileTree(tree, new Set(), 0);
    expect(flat.length).toBeGreaterThan(1);
    const dirRow = flat.find((r) => r.node.type === "directory");
    expect(dirRow?.node.expanded).toBe(true);
  });

  it("skips children when directory path is collapsed", () => {
    const tree = buildFileTree([leaf("1", "a/b.ts", "b.ts")]);
    const collapsed = new Set<string>(["a"]);
    const flat = flattenFileTree(tree, collapsed, 0);
    expect(flat.some((r) => r.node.type === "file")).toBe(false);
  });
});

describe("countFileNodes", () => {
  it("counts only file leaves", () => {
    const tree = buildFileTree([
      leaf("1", "x/a.ts", "a.ts"),
      leaf("2", "x/b.ts", "b.ts"),
    ]);
    expect(countFileNodes(tree)).toBe(2);
  });
});

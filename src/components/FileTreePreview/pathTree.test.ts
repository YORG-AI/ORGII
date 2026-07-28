import { describe, expect, it } from "vitest";

import { buildFileTree, getRepoRelativePath } from "./pathTree";
import type { TreeNode } from "./types";

function flattenNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

describe("FileTreePreview path parsing", () => {
  it("builds separate levels from a Windows path", () => {
    const tree = buildFileTree(
      String.raw`C:\Projects\ORGII\src\engines\useChatProjection.test.ts`
    );

    const nodes = flattenNodes(tree);

    expect(nodes.map((node) => node.name)).toEqual([
      "C:",
      "Projects",
      "ORGII",
      "src",
      "engines",
      "useChatProjection.test.ts",
    ]);
    expect(nodes.at(-1)).toMatchObject({
      name: "useChatProjection.test.ts",
      isFile: true,
      isHighlighted: true,
    });
  });

  it("handles mixed Windows and POSIX separators", () => {
    const tree = buildFileTree(String.raw`C:\Projects/ORGII\src/file.ts`);

    expect(flattenNodes(tree).map((node) => node.name)).toEqual([
      "C:",
      "Projects",
      "ORGII",
      "src",
      "file.ts",
    ]);
  });

  it("makes a Windows path relative to a Windows repo root", () => {
    expect(
      getRepoRelativePath(
        String.raw`C:\Projects\ORGII\src\engines\file.ts`,
        String.raw`c:\projects\orgii`
      )
    ).toBe("ORGII/src/engines/file.ts");
  });

  it("retains the existing macOS GitHub repo shortening", () => {
    expect(
      getRepoRelativePath(
        "/Users/dev/Documents/GitHub/ORGII/src/engines/file.ts"
      )
    ).toBe("ORGII/src/engines/file.ts");
  });
});

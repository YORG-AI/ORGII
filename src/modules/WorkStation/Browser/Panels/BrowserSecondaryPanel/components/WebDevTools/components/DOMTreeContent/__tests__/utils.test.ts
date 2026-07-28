import { describe, expect, it } from "vitest";

import type { DOMTreeNode } from "@src/modules/WorkStation/Browser/hooks/useWebviewDOMTree";

import {
  findNodeIndex,
  flattenDOMTree,
  shouldVirtualizeDOMTree,
} from "../utils";

function node(xpath: string, children: DOMTreeNode[] = []): DOMTreeNode {
  return { xpath, children } as DOMTreeNode;
}

describe("DOMTreeContent model", () => {
  const tree = node("/html", [
    node("/html/body", [node("/html/body/main")]),
    node("/html/head"),
  ]);

  it("flattens only descendants whose parents are expanded", () => {
    expect(flattenDOMTree(tree, new Set())).toEqual([{ node: tree, depth: 0 }]);

    const visible = flattenDOMTree(tree, new Set(["/html", "/html/body"]));
    expect(visible.map(({ node: item, depth }) => [item.xpath, depth])).toEqual(
      [
        ["/html", 0],
        ["/html/body", 1],
        ["/html/body/main", 2],
        ["/html/head", 1],
      ]
    );
  });

  it("resolves visible node indexes", () => {
    const visible = flattenDOMTree(tree, new Set(["/html"]));
    expect(findNodeIndex(visible, "/html/head")).toBe(2);
    expect(findNodeIndex(visible, "/missing")).toBe(-1);
  });

  it("virtualizes only above the established threshold", () => {
    expect(shouldVirtualizeDOMTree(50)).toBe(false);
    expect(shouldVirtualizeDOMTree(51)).toBe(true);
  });
});

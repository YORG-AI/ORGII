import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TreeRowBase } from "./TreeRowBase";

const node = {
  id: "src",
  name: "src",
  path: "src",
  type: "directory" as const,
};

describe("TreeRowBase", () => {
  it("lets a padded host own the row inset", () => {
    const markup = renderToStaticMarkup(
      createElement(TreeRowBase, { node, depth: 0, inset: false })
    );

    expect(markup).not.toContain(" mx-1 ");
    expect(markup).toContain("padding-left:16px");
    expect(markup).toContain("padding-right:8px");
  });

  it("keeps the sidebar inset by default", () => {
    const markup = renderToStaticMarkup(
      createElement(TreeRowBase, { node, depth: 0 })
    );

    expect(markup).toContain(" mx-1 ");
    expect(markup).toContain("padding-left:12px");
    expect(markup).toContain("padding-right:4px");
  });
});

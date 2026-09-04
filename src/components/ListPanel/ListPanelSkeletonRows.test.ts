import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ListPanelItem from "./ListPanelItem";
import { ListPanelSkeletonRows } from "./ListPanelSkeletonRows";

describe("ListPanelSkeletonRows", () => {
  it("never animates, so a short load does not read as a flash", () => {
    const markup = renderToStaticMarkup(createElement(ListPanelSkeletonRows));

    expect(markup).not.toContain("animate-pulse");
    expect(markup).not.toContain("animate-");
  });

  it("holds the same row geometry as a loaded list row", () => {
    const skeleton = renderToStaticMarkup(
      createElement(ListPanelSkeletonRows, { count: 1 })
    );
    const loaded = renderToStaticMarkup(
      createElement(ListPanelItem, {
        id: "row",
        selected: false,
        title: "Loaded row",
        time: "1d",
        metadata: "ORG2",
        leading: createElement("span"),
        ariaLabel: "Loaded row",
        onClick: vi.fn(),
      })
    );

    // Row padding, the 16px title line, the 20px metadata line, and the
    // metadata indent all come from ListPanelItem; a mismatch would make the
    // list jump when real rows replace skeletons.
    for (const geometry of [
      "px-3",
      "rounded-lg",
      "py-1.5",
      "flex h-4 min-w-0 items-center",
      "h-5 min-w-0 items-center",
      "pl-7",
    ]) {
      expect(skeleton).toContain(geometry);
      expect(loaded).toContain(geometry);
    }
  });

  it("stays out of the accessibility tree and varies row widths", () => {
    const markup = renderToStaticMarkup(
      createElement(ListPanelSkeletonRows, { count: 4 })
    );

    expect(markup.match(/data-testid="list-panel-skeleton-row"/g)).toHaveLength(
      4
    );
    expect(markup).toContain('data-testid="list-panel-skeleton-rows"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('role="option"');
    // Cycled title widths keep a stack from reading as a grid.
    for (const width of ["w-3/5", "w-2/5", "w-1/2", "w-2/3"]) {
      expect(markup).toContain(width);
    }
  });
});

// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { VirtuosoMockContext } from "react-virtuoso";
import { describe, expect, it } from "vitest";

import VirtualizedGroupedList from ".";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("VirtualizedGroupedList", () => {
  it("keeps collapsed headers interactive without mounting their rows", () => {
    const groups = [
      { key: "open", group: "Open group", items: ["item-a", "item-b"] },
      { key: "closed", group: "Closed group", items: ["item-d"] },
    ];

    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(
          VirtuosoMockContext.Provider,
          { value: { viewportHeight: 60, itemHeight: 20 } },
          React.createElement(VirtualizedGroupedList<string, string>, {
            groups,
            defaultExpanded: (group) => group.key === "open",
            getItemKey: (value) => value,
            renderGroupHeader: (group, expanded, onExpandedChange) =>
              React.createElement(
                "button",
                { onClick: () => onExpandedChange(!expanded) },
                group
              ),
            renderItem: (value) => React.createElement("div", null, value),
          })
        )
      );
    });

    expect(container.textContent).toContain("Open group");
    expect(container.textContent).toContain("Closed group");
    expect(container.textContent).toContain("item-a");
    expect(container.textContent).not.toContain("item-d");

    const closedGroupButton = Array.from(
      container.querySelectorAll("button")
    ).find((button) => button.textContent === "Closed group");
    expect(closedGroupButton).toBeTruthy();
    act(() => closedGroupButton?.click());
    expect(container.textContent).toContain("item-d");

    act(() => root.unmount());
  });

  it("mounts only the viewport window for a large expanded group", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const items = Array.from({ length: 100 }, (_, index) => `row-${index}`);

    act(() => {
      root.render(
        React.createElement(
          VirtuosoMockContext.Provider,
          { value: { viewportHeight: 60, itemHeight: 20 } },
          React.createElement(VirtualizedGroupedList<string, string>, {
            groups: [{ key: "all", group: "All", items }],
            defaultExpanded: () => true,
            getItemKey: (value) => value,
            renderGroupHeader: (group) =>
              React.createElement("h2", null, group),
            renderItem: (value) => React.createElement("div", null, value),
          })
        )
      );
    });

    expect(container.textContent).toContain("row-0");
    expect(container.textContent).not.toContain("row-99");
    expect(container.querySelectorAll("[data-item-index]").length).toBeLessThan(
      items.length
    );

    act(() => root.unmount());
  });
});

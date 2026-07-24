import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SimulatorTreePanel from "../SimulatorTreePanel";

vi.mock("@src/components/VirtualizedStickyTree", async () => {
  const ReactModule = await import("react");

  return {
    CHEVRON_SIZE: 12,
    STICKY_ROW: {
      row: "",
      chevronBox: "",
      chevronIcon: "",
      name: "",
    },
    stickyRowPadding: () => ({}),
    VirtualizedStickyTree: ({
      flattenedNodes,
      renderItem,
    }: {
      flattenedNodes: unknown[];
      renderItem: (item: unknown, index: number) => React.ReactNode;
    }) =>
      ReactModule.createElement(
        ReactModule.Fragment,
        null,
        flattenedNodes.map((item, index) =>
          ReactModule.createElement(
            ReactModule.Fragment,
            { key: index },
            renderItem(item, index)
          )
        )
      ),
  };
});

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../../../../shared/hooks/usePrimarySidebarSurface", () => ({
  usePrimarySidebarSurface: () => ({ stickyBgClass: "bg-sidebar" }),
}));

describe("SimulatorTreePanel", () => {
  it("renders the original file name and icon without right-side metadata", () => {
    const legacyItem = {
      id: "read-1",
      filePath: "src/simulatorAtom.ts",
      fileName: "simulatorAtom.ts",
      icon: React.createElement("span", { "data-testid": "file-icon" }, "TS"),
      secondaryInfo: "#9 · ui",
    };

    const markup = renderToStaticMarkup(
      React.createElement(SimulatorTreePanel, {
        items: [legacyItem],
        selectedId: null,
        agentSelectedIds: new Set<string>(),
        onSelectItem: () => undefined,
        emptyMessage: "No files read",
        viewMode: "list",
      })
    );

    expect(markup).toContain("simulatorAtom.ts");
    expect(markup).toContain('data-testid="file-icon"');
    expect(markup).not.toContain("#9");
    expect(markup).not.toContain("· ui");
  });
});

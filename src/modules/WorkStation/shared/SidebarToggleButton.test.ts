import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SidebarToggleButton } from "./SidebarToggleButton";

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SidebarToggleButton", () => {
  it("uses a left-aligned layout icon for left sidebars", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarToggleButton, {
        collapsed: false,
        onToggle: () => undefined,
        position: "left",
        stableAlignmentIcon: true,
      })
    );

    expect(markup).toContain('data-icon="layout-align-left"');
  });

  it("uses a right-aligned layout icon for right sidebars", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarToggleButton, {
        collapsed: false,
        onToggle: () => undefined,
        position: "right",
        stableAlignmentIcon: true,
      })
    );

    expect(markup).toContain('data-icon="layout-align-right"');
  });
});

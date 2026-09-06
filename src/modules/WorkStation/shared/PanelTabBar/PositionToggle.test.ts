import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PanelPositionToggle } from "./PositionToggle";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("PanelPositionToggle", () => {
  it("shows the destination direction", () => {
    const moveToBottom = renderToStaticMarkup(
      React.createElement(PanelPositionToggle, {
        position: "right",
        onToggle: vi.fn(),
      })
    );
    const moveToRight = renderToStaticMarkup(
      React.createElement(PanelPositionToggle, {
        position: "bottom",
        onToggle: vi.fn(),
      })
    );

    expect(moveToBottom).toContain('data-icon="arrow-big-down-dash"');
    expect(moveToRight).toContain('data-icon="arrow-big-right-dash"');
  });
});

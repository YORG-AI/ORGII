import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkstationMaximizeChatIcon } from "./useWorkstationTrailingSlot";

describe("WorkstationMaximizeChatIcon", () => {
  it("keeps the X unchanged when the workstation is left of the chat panel", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationMaximizeChatIcon, {
        chatPanelPosition: "right",
      })
    );

    expect(markup).toContain('data-icon="x"');
    expect(markup).not.toContain("group-hover");
    expect(markup).not.toContain('data-icon="panel-left-close"');
  });

  it("preserves the directional hover affordance when the chat panel is left", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationMaximizeChatIcon, {
        chatPanelPosition: "left",
      })
    );

    expect(markup).toContain('data-icon="panel-right"');
    expect(markup).toContain('data-icon="layout-align-right"');
    expect(markup).toContain("hidden group-hover:block");
  });
});

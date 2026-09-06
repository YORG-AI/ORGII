import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import BrowserStatusBar from "../BrowserStatusBar";

vi.mock("../PortsStatusMenu", () => ({
  PortsStatusMenu: () =>
    React.createElement("span", { "data-testid": "status-bar-ports" }),
}));

describe("BrowserStatusBar", () => {
  it("includes the shared running-servers menu", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BrowserStatusBar, {
        url: "",
        isLoading: false,
        errorCount: 0,
        warningCount: 0,
        isDevToolsOpen: false,
        onToggleDevTools: vi.fn(),
        sessionCount: 0,
        currentSessionIndex: 0,
      })
    );

    expect(markup).toContain('data-testid="status-bar-ports"');
  });
});

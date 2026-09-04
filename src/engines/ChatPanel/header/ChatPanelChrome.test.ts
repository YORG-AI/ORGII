import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatPanelChrome } from "./ChatPanelChrome";

describe("ChatPanelChrome", () => {
  it("shares the desktop tab row and published header frame", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ChatPanelChrome, {
        tabStrip: React.createElement("span", null, "Session tab"),
        toolbar: React.createElement("button", null, "Refresh"),
        publishedHeaderSlots: {
          content: React.createElement("span", null, "SDE Agent"),
          trailing: React.createElement("span", null, "Read only"),
        },
      })
    );

    expect(markup).toContain('data-testid="chat-panel-header-glass"');
    expect(markup).toContain('data-testid="chat-panel-header"');
    expect(markup).toContain('data-testid="chat-panel-published-header"');
    expect(markup).toContain("workspace-header header-tab-group");
    expect(markup).toContain("Session tab");
    expect(markup).toContain("SDE Agent");
    expect(markup).toContain("Read only");
  });

  it("does not reserve a published-header row when no slots are supplied", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ChatPanelChrome, {
        tabStrip: React.createElement("span", null, "Only tab row"),
      })
    );

    expect(markup).not.toContain('data-testid="chat-panel-published-header"');
    expect(markup).toContain("height:44px");
  });
});

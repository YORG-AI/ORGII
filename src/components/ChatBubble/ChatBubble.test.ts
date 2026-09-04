import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";

import {
  CHAT_BUBBLE_WIDTH_TOKENS,
  CHAT_SESSION_USER_BUBBLE_CLASS,
  ChatAssistantMessageBody,
  ChatBubbleBody,
} from "./index";

describe("session chat message surfaces", () => {
  it("keeps the bubble row on the chat reading measure", () => {
    // The conversation column is 800px. A merge once rebound this row to
    // the 900px detail-panel measure, which left bubbles wider than the
    // header and pager they sit under.
    expect(CHAT_BUBBLE_WIDTH_TOKENS.row).toContain(
      CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth
    );
  });

  it("keeps assistant content transparent and on the shared chat typography", () => {
    // Keep the repository's `.test.ts` placement while passing children via
    // React's dedicated argument rather than the discouraged `children` prop.
    const props = {
      testId: "assistant",
    } as React.ComponentProps<typeof ChatAssistantMessageBody>;
    const html = renderToStaticMarkup(
      React.createElement(ChatAssistantMessageBody, props, "Answer")
    );

    expect(html).toContain('data-testid="assistant"');
    expect(html).toContain("chat-text");
    expect(html).toContain("resultBgc");
    expect(html).not.toContain("bg-fill-2");
    expect(html).not.toContain("rounded-2xl");
  });

  it("publishes one user-bubble treatment for desktop and mobile", () => {
    const props = {
      variant: "sessionUser",
    } as React.ComponentProps<typeof ChatBubbleBody>;
    const html = renderToStaticMarkup(
      React.createElement(ChatBubbleBody, props, "Ask")
    );

    for (const token of CHAT_SESSION_USER_BUBBLE_CLASS.split(" ")) {
      expect(html).toContain(token);
    }
  });
});

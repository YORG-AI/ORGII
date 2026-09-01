import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CHAT_SESSION_USER_BUBBLE_CLASS,
  ChatAssistantMessageBody,
  ChatBubbleBody,
} from "./index";

describe("session chat message surfaces", () => {
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

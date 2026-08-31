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
    const html = renderToStaticMarkup(
      // The test suite is intentionally `.ts`; React's typed createElement
      // overload therefore requires the required child in the props object.
      // eslint-disable-next-line react/no-children-prop
      React.createElement(ChatAssistantMessageBody, {
        testId: "assistant",
        children: "Answer",
      })
    );

    expect(html).toContain('data-testid="assistant"');
    expect(html).toContain("chat-text");
    expect(html).toContain("resultBgc");
    expect(html).not.toContain("bg-fill-2");
    expect(html).not.toContain("rounded-2xl");
  });

  it("publishes one user-bubble treatment for desktop and mobile", () => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop
      React.createElement(ChatBubbleBody, {
        variant: "sessionUser",
        children: "Ask",
      })
    );

    for (const token of CHAT_SESSION_USER_BUBBLE_CLASS.split(" ")) {
      expect(html).toContain(token);
    }
  });
});

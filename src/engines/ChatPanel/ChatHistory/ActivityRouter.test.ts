import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { makeSessionEvent } from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import ActivityChatItem from "./ActivityRouter";

describe("ActivityChatItem initial loading placeholder", () => {
  it("renders the shared block instead of synthetic loading text", () => {
    const event = makeSessionEvent({
      id: "loading",
      action_type: "assistant",
      function: "assistant_message",
      result: { observation: "Loading..." },
    });

    const markup = renderToStaticMarkup(
      createElement(ActivityChatItem, { event })
    );

    expect(markup).toContain('data-testid="chat-loading-block"');
    expect(markup).not.toContain("Loading...");
  });
});

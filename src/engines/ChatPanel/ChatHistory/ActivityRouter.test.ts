import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { makeSessionEvent } from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import ActivityChatItem from "./ActivityRouter";

vi.mock("../ChatItems/AgentErrorChatItem", () => ({
  default: ({ errorMessage }: { errorMessage: string }) =>
    `routed-agent-error:${errorMessage}`,
}));

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

describe("ActivityChatItem error routing", () => {
  it("renders a standard CLI error chunk with its error body", () => {
    const event = makeSessionEvent({
      action_type: "error",
      function: "error",
      result: {
        error: "unexpected status 402 Payment Required",
        success: false,
      },
      displayText: "unexpected status 402 Payment Required",
      displayStatus: "failed",
      displayVariant: "error",
    });

    const markup = renderToStaticMarkup(
      createElement(ActivityChatItem, { event })
    );

    expect(markup).toContain(
      "routed-agent-error:unexpected status 402 Payment Required"
    );
  });

  it("renders a failed session_end with its terminal error body", () => {
    const event = makeSessionEvent({
      action_type: "session_end",
      function: "session_end",
      result: {
        error_message: "provider rejected the request",
        success: false,
      },
      displayText: "provider rejected the request",
      displayStatus: "failed",
      displayVariant: "error",
    });

    const markup = renderToStaticMarkup(
      createElement(ActivityChatItem, { event })
    );

    expect(markup).toContain(
      "routed-agent-error:provider rejected the request"
    );
  });
});

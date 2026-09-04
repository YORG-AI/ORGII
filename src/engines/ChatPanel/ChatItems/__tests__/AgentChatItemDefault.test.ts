import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AgentChatItemDefault from "../AgentChatItemDefault";

describe("AgentChatItemDefault message chrome", () => {
  it("does not render a message-level copy control", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AgentChatItemDefault,
        {
          messageTimestamp: "2026-09-01T14:55:00.000Z",
        } as ComponentProps<typeof AgentChatItemDefault>,
        "Assistant response"
      )
    );

    expect(markup).not.toContain('data-icon="copy"');
    expect(markup).not.toContain("<time");
  });
});

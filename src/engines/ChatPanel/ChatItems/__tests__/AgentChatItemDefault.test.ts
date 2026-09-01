import { type ComponentProps, type FC, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AgentChatItemDefault from "../AgentChatItemDefault";

const TestableAgentChatItemDefault = AgentChatItemDefault as FC<
  Partial<ComponentProps<typeof AgentChatItemDefault>>
>;

describe("AgentChatItemDefault message chrome", () => {
  it("does not render a message-level copy control", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TestableAgentChatItemDefault,
        {
          expand: true,
          finish: true,
          itemIndex: 0,
          messageTimestamp: "2026-09-01T14:55:00.000Z",
        },
        "Assistant response"
      )
    );

    expect(markup).not.toContain('data-icon="copy"');
    expect(markup).not.toContain("<time");
  });
});

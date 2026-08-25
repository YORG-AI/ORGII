import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentTurnContext } from "@src/engines/ChatPanel/ChatHistory/AgentTurnContext";

import AgentMessageBlock, {
  AGENT_MESSAGE_PREVIEW_MAX_HEIGHT,
  resolveAgentMessageClampEligibility,
  shouldShowAgentMessageFooter,
} from "../index";

describe("resolveAgentMessageClampEligibility", () => {
  it("clamps non-final rounds", () => {
    expect(resolveAgentMessageClampEligibility(false, false)).toBe(true);
  });

  it("clamps the latest round too (the streaming tail is exempted by the caller)", () => {
    expect(resolveAgentMessageClampEligibility(true, false)).toBe(true);
    expect(resolveAgentMessageClampEligibility(true, true)).toBe(true);
  });

  it("uses the host fallback outside a turn context", () => {
    expect(resolveAgentMessageClampEligibility(null, true)).toBe(true);
    expect(resolveAgentMessageClampEligibility(null, false)).toBe(false);
  });
});

describe("agent message preview height", () => {
  it("restores the twenty-line preview depth", () => {
    expect(AGENT_MESSAGE_PREVIEW_MAX_HEIGHT).toBe(20 * 24);
  });
});

describe("shouldShowAgentMessageFooter", () => {
  it("shows below the final settled assistant message in a round", () => {
    expect(
      shouldShowAgentMessageFooter({
        content: "Done",
        isStreaming: false,
        itemIndex: 7,
        lastAssistantFlatIndex: 7,
      })
    ).toBe(true);
  });

  it("hides for earlier assistant messages and streaming tails", () => {
    expect(
      shouldShowAgentMessageFooter({
        content: "Working",
        isStreaming: false,
        itemIndex: 6,
        lastAssistantFlatIndex: 7,
      })
    ).toBe(false);
    expect(
      shouldShowAgentMessageFooter({
        content: "Still streaming",
        isStreaming: true,
        itemIndex: 7,
        lastAssistantFlatIndex: 7,
      })
    ).toBe(false);
  });

  it("hides outside turn context and for empty messages", () => {
    expect(
      shouldShowAgentMessageFooter({
        content: "Synthetic preview",
        isStreaming: false,
        itemIndex: 0,
        lastAssistantFlatIndex: null,
      })
    ).toBe(false);
    expect(
      shouldShowAgentMessageFooter({
        content: "   ",
        isStreaming: false,
        itemIndex: 0,
        lastAssistantFlatIndex: 0,
      })
    ).toBe(false);
  });

  it("offers complete-turn copy only when the resident turn sources exist", () => {
    const render = (assistantCopyEventIds: readonly string[]) =>
      renderToStaticMarkup(
        createElement(
          AgentTurnContext.Provider,
          {
            value: {
              lastAssistantFlatIndex: 7,
              assistantCopyEventIds,
              resolveAssistantTurnCopyContent: () => "complete turn",
              isLastGroup: false,
              isLastItemInGroup: true,
            },
          },
          createElement(
            AgentMessageBlock,
            {
              itemIndex: 7,
              messageContent: "visible final answer",
              messageTimestamp: "2026-08-25T00:00:00.000Z",
            } as ComponentProps<typeof AgentMessageBlock>,
            "visible final answer"
          )
        )
      );

    expect(render(["assistant-1", "assistant-2"])).toContain(
      'data-testid="message-footer-copy"'
    );
    const unloadedMarkup = render([]);
    expect(unloadedMarkup).toContain('data-testid="message-footer"');
    expect(unloadedMarkup).not.toContain('data-testid="message-footer-copy"');
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AgentMessageBlock, {
  AGENT_MESSAGE_PREVIEW_MAX_HEIGHT,
  resolveAgentMessageClampEligibility,
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

describe("agent message chrome", () => {
  it("does not render copy or timestamp footer controls", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMessageBlock, null, "visible final answer")
    );

    expect(markup).not.toContain('data-testid="message-footer"');
    expect(markup).not.toContain("<time");
  });
});

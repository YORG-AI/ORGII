import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RecipeRendererProps } from "../RecipeRenderer";
import { RecipeRenderer } from "../RecipeRenderer";

vi.mock("@src/engines/ChatPanel/hooks/useChatEventReplay", () => ({
  useChatEventReplay: () => ({
    replayEventById: vi.fn(),
    canReplay: false,
  }),
}));

function renderFallbackEvent(
  result: Record<string, unknown>,
  status: "completed" | "failed" = "completed"
) {
  const props: RecipeRendererProps = {
    event_id: "event-uncategorized-test",
    functionName: "uncategorized_tool",
    uiCanonical: "tool_call",
    action_type: "tool_call",
    args: { value: "input details" },
    result,
    status,
  };

  return renderToStaticMarkup(createElement(RecipeRenderer, props));
}

describe("FallbackAdapter generic tool rendering", () => {
  it("collapses uncategorized events by default", () => {
    const markup = renderFallbackEvent({ observation: "output details" });

    expect(markup).toContain('data-tool-call-name="uncategorized_tool"');
    expect(markup).not.toContain("input details");
    expect(markup).not.toContain("output details");
  });

  it("collapses uncategorized errors by default", () => {
    const markup = renderFallbackEvent(
      { error: "fallback failure details" },
      "failed"
    );

    expect(markup).not.toContain("fallback failure details");
  });
});

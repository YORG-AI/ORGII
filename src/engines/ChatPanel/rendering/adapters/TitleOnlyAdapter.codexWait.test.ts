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

describe("TitleOnlyAdapter Codex wait rendering", () => {
  it("renders Codex wait payloads with the dedicated wait lifecycle", () => {
    const props: RecipeRendererProps = {
      event_id: "event-codex-wait",
      functionName: "await_output",
      uiCanonical: "await_output",
      action_type: "tool_call",
      args: { cell_id: "12", max_tokens: 4000, yield_time_ms: 1000 },
      result: {
        observation:
          "Script running with cell ID 12\nWall time 1.0 seconds\nOutput:",
      },
      status: "completed",
    };

    const markup = renderToStaticMarkup(createElement(RecipeRenderer, props));

    expect(markup).toContain('data-tool-call-name="await_output"');
    expect(markup).toContain("tools.awaitOutputDone");
    expect(markup).not.toContain("cell_id");
    expect(markup).not.toContain("Script running with cell ID");
  });
});

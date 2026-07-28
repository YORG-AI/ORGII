import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";

import { OrgTaskAdapter } from "./OrgTaskAdapter";

vi.mock("@src/engines/ChatPanel/hooks/useChatEventReplay", () => ({
  useChatEventReplay: () => ({
    replayEventById: vi.fn(),
    canReplay: false,
  }),
}));

const baseProps: UniversalEventProps = {
  eventId: "event-task-update-test",
  eventType: "task_update",
  functionName: "task_update",
  args: { summary: "raw task input" },
  result: { guidance: "raw task output" },
  status: "success",
  variant: "chat",
  context: "chat",
};

describe("OrgTaskAdapter raw fallback rendering", () => {
  it("collapses raw task events when extracted task data is unavailable", () => {
    const markup = renderToStaticMarkup(
      createElement(OrgTaskAdapter, baseProps)
    );

    expect(markup).toContain('data-tool-call-name="task_update"');
    expect(markup).not.toContain("raw task input");
    expect(markup).not.toContain("raw task output");
  });

  it("collapses raw task events when extraction has no renderable task", () => {
    const markup = renderToStaticMarkup(
      createElement(OrgTaskAdapter, {
        ...baseProps,
        rustExtracted: {
          kind: "orgTask",
          action: "update",
          outcome: "succeeded",
        },
      })
    );

    expect(markup).not.toContain("raw task input");
    expect(markup).not.toContain("raw task output");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";

import { CanvasInlineAdapter } from "./CanvasInlineAdapter";

vi.mock("@src/engines/ChatPanel/blocks/CanvasInlineCard", () => ({
  default: () => createElement("div", { "data-testid": "canvas-card" }),
}));

vi.mock(
  "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasRevisionActivity",
  () => ({
    default: ({
      errorDetail,
      eventId,
    }: {
      errorDetail?: string;
      eventId?: string;
    }) =>
      createElement(
        "div",
        {
          "data-testid": "canvas-revision-activity",
          "data-event-id": eventId,
        },
        errorDetail
      ),
  })
);

vi.mock("@src/engines/SessionCore/rendering/registry", () => ({
  statusToLifecycle: (status: string) => status,
  useLifecycleLabels: () => ({
    completed: "Completed",
    failed: "Failed",
    running: "Running",
  }),
}));

vi.mock("@src/util/ui/rendering/toolAction", () => ({
  deriveToolAction: () => "render",
}));

function canvasProps(
  args: Record<string, unknown>,
  status: "success" | "running" | "failed" = "success",
  functionName = "revise_inline_canvas"
): UniversalEventProps {
  return {
    eventId: "event-b",
    eventType: "canvas_inline",
    functionName,
    sessionId: "session-a",
    args,
    result: status === "failed" ? { error: "Revision failed" } : {},
    status,
  } as unknown as UniversalEventProps;
}

describe("CanvasInlineAdapter revisions", () => {
  it("renders a persistent activity record instead of a second Canvas card", () => {
    const markup = renderToStaticMarkup(
      createElement(
        CanvasInlineAdapter,
        canvasProps({
          mode: "react",
          content: "function App() {}",
          target_event_id: "event-a",
        })
      )
    );

    expect(markup).toContain('data-testid="canvas-revision-activity"');
    expect(markup).toContain('data-event-id="event-b"');
    expect(markup).not.toContain('data-testid="canvas-card"');
  });

  it("still surfaces a failed revision", () => {
    const markup = renderToStaticMarkup(
      createElement(
        CanvasInlineAdapter,
        canvasProps(
          {
            mode: "react",
            content: "function App() {}",
            target_event_id: "event-a",
          },
          "failed"
        )
      )
    );

    expect(markup).toContain("Revision failed");
  });

  it("does not hide a legacy create event solely because it has malformed revision metadata", () => {
    const markup = renderToStaticMarkup(
      createElement(
        CanvasInlineAdapter,
        canvasProps(
          {
            mode: "react",
            content: "function App() {}",
            revises_event_id: "missing-event",
          },
          "success",
          "render_inline_canvas"
        )
      )
    );

    expect(markup).toContain('data-testid="canvas-card"');
  });
});

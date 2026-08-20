import { describe, expect, it } from "vitest";

import {
  getCanvasRevisionAgentSteps,
  getCanvasRevisionTargetId,
  isCanvasRevisionPayload,
  isCanvasRevisionToolName,
  isSameLogicalCanvas,
} from "./canvasRevision";

describe("Canvas revision identity", () => {
  it("reads the dedicated target id and keeps the legacy field compatible", () => {
    expect(getCanvasRevisionTargetId({ target_event_id: " event-new " })).toBe(
      "event-new"
    );
    expect(getCanvasRevisionTargetId({ revises_event_id: " event-a " })).toBe(
      "event-a"
    );
    expect(getCanvasRevisionTargetId({ revises_event_id: "  " })).toBeNull();
    expect(getCanvasRevisionTargetId({ revises_event_id: 42 })).toBeNull();
    expect(isCanvasRevisionToolName("revise_inline_canvas")).toBe(true);
    expect(isCanvasRevisionToolName("render_inline_canvas")).toBe(false);
  });

  it("recognizes a direct revision as the same logical Canvas", () => {
    const previous = { mode: "react" as const, eventId: "event-a" };
    const revision = {
      mode: "react" as const,
      eventId: "event-b",
      revisesEventId: "event-a",
    };

    expect(isCanvasRevisionPayload(revision)).toBe(true);
    expect(isSameLogicalCanvas(previous, revision)).toBe(true);
    expect(
      isSameLogicalCanvas(previous, {
        mode: "react",
        eventId: "event-c",
      })
    ).toBe(false);
  });

  it("accepts only bounded agent-generated progress labels", () => {
    expect(
      getCanvasRevisionAgentSteps({
        agent_steps: ["  替换按钮文案  ", "核对原有交互"],
      })
    ).toEqual(["替换按钮文案", "核对原有交互"]);
    expect(getCanvasRevisionAgentSteps({})).toBeNull();
    expect(getCanvasRevisionAgentSteps({ agent_steps: ["   "] })).toBeNull();
    expect(
      getCanvasRevisionAgentSteps({ agent_steps: ["x".repeat(81)] })
    ).toBeNull();
    expect(
      getCanvasRevisionAgentSteps({
        agent_steps: ["1", "2", "3", "4", "5", "6", "7"],
      })
    ).toBeNull();
  });
});

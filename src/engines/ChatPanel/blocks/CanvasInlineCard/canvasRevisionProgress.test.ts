import { describe, expect, it } from "vitest";

import type { CanvasRevisionDraft } from "@src/store/session/canvasRevisionDraftAtom";

import {
  formatCanvasRevisionCharacterCount,
  isCanvasRevisionDraftRelevant,
} from "./canvasRevisionProgressState";

function draft(
  overrides: Partial<CanvasRevisionDraft> = {}
): CanvasRevisionDraft {
  return {
    sessionId: "session-a",
    toolCallId: "revision-a",
    targetEventId: "canvas-a",
    receivedCharacters: 1_200,
    phase: "receiving",
    startedAt: 1,
    ...overrides,
  };
}

describe("Canvas revision progress", () => {
  it("formats bounded progress without pretending it is a percentage", () => {
    expect(formatCanvasRevisionCharacterCount(0)).toBe("0");
    expect(formatCanvasRevisionCharacterCount(999)).toBe("999");
    expect(formatCanvasRevisionCharacterCount(1_200)).toBe("1.2K");
    expect(formatCanvasRevisionCharacterCount(21_162)).toBe("21K");
  });

  it("only paints a draft on its owning session and selected Canvas", () => {
    expect(
      isCanvasRevisionDraftRelevant(draft(), "session-a", "canvas-a")
    ).toBe(true);
    expect(
      isCanvasRevisionDraftRelevant(draft(), "session-b", "canvas-a")
    ).toBe(false);
    expect(
      isCanvasRevisionDraftRelevant(draft(), "session-a", "canvas-b")
    ).toBe(false);
    expect(
      isCanvasRevisionDraftRelevant(
        draft(),
        "session-a",
        "tool-call-revision-a"
      )
    ).toBe(true);
  });

  it("shows an early draft before target metadata has finished streaming", () => {
    expect(
      isCanvasRevisionDraftRelevant(
        draft({ targetEventId: undefined }),
        "session-a",
        "canvas-a"
      )
    ).toBe(true);
  });
});

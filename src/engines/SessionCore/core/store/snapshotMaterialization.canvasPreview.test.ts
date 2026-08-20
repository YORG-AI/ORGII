import { describe, expect, it } from "vitest";

import type { SessionEvent } from "../types";
import { isCanvasEvent } from "./snapshotMaterialization.canvasPreview";

function event(functionName: string, uiCanonical = "fallback"): SessionEvent {
  return {
    id: `event-${functionName}`,
    functionName,
    uiCanonical,
  } as unknown as SessionEvent;
}

describe("Canvas snapshot materialization", () => {
  it("recognizes both create and revision tools before registry hydration", () => {
    expect(isCanvasEvent(event("render_inline_canvas"))).toBe(true);
    expect(isCanvasEvent(event("revise_inline_canvas"))).toBe(true);
    expect(isCanvasEvent(event("unknown", "canvas_inline"))).toBe(true);
    expect(isCanvasEvent(event("read_file"))).toBe(false);
  });
});

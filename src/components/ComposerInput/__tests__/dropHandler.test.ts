/**
 * Tests for createDropHandler in pasteHandlers.ts
 *
 * Verifies that the drop handler correctly returns false (does not consume)
 * for OS file drops (no reference drag data) so the caller can always
 * call event.preventDefault() itself — preventing browser default behavior
 * (inserting file name as text) which caused empty conversation rounds.
 *
 * See: GitHub issue #250
 */
import { describe, expect, it, vi } from "vitest";

import { createDropHandler } from "../pasteHandlers";

function makeDragEvent(
  options: {
    dataTransfer?: Partial<DataTransfer> | null;
  } = {}
): DragEvent {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = Object.create(Event.prototype) as DragEvent;
  Object.defineProperties(event, {
    preventDefault: { value: preventDefault },
    stopPropagation: { value: stopPropagation },
    dataTransfer: { value: options.dataTransfer ?? null },
  });
  return event;
}

function makeDropHandlerCtx() {
  return {
    insertPill: vi.fn(),
  };
}

describe("createDropHandler — OS file drops", () => {
  it("returns false for a drop with no dataTransfer", () => {
    const handler = createDropHandler(makeDropHandlerCtx());
    const event = makeDragEvent({ dataTransfer: null });
    expect(handler(event)).toBe(false);
  });

  it("returns false for a drop with no recognised MIME types (plain OS file drop)", () => {
    const handler = createDropHandler(makeDropHandlerCtx());
    const dataTransfer = {
      types: ["Files"],
      getData: vi.fn().mockReturnValue(""),
      files: [],
      items: [],
    } as unknown as DataTransfer;
    const event = makeDragEvent({ dataTransfer });
    expect(handler(event)).toBe(false);
  });

  it("does NOT call insertPill for plain OS file drops", () => {
    const ctx = makeDropHandlerCtx();
    const handler = createDropHandler(ctx);
    const dataTransfer = {
      types: ["Files"],
      getData: vi.fn().mockReturnValue(""),
    } as unknown as DataTransfer;
    const event = makeDragEvent({ dataTransfer });
    handler(event);
    expect(ctx.insertPill).not.toHaveBeenCalled();
  });

  it("does NOT call event.preventDefault() — that is the caller's responsibility", () => {
    const handler = createDropHandler(makeDropHandlerCtx());
    const dataTransfer = {
      types: ["Files"],
      getData: vi.fn().mockReturnValue(""),
    } as unknown as DataTransfer;
    const event = makeDragEvent({ dataTransfer });
    handler(event);
    // createDropHandler intentionally does NOT call preventDefault for non-reference
    // drops — the caller (handleDropEvent in ComposerInput/index.tsx) always calls
    // event.preventDefault() before invoking this handler so the browser can never
    // insert file content into the contenteditable.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("createDropHandler — empty dataTransfer types", () => {
  it("returns false when dataTransfer has empty types array", () => {
    const handler = createDropHandler(makeDropHandlerCtx());
    const dataTransfer = {
      types: [],
      getData: vi.fn().mockReturnValue(""),
    } as unknown as DataTransfer;
    const event = makeDragEvent({ dataTransfer });
    expect(handler(event)).toBe(false);
  });

  it("returns false for a text/plain drop (not a reference drag)", () => {
    const handler = createDropHandler(makeDropHandlerCtx());
    const dataTransfer = {
      types: ["text/plain"],
      getData: vi.fn().mockReturnValue("some text"),
    } as unknown as DataTransfer;
    const event = makeDragEvent({ dataTransfer });
    expect(handler(event)).toBe(false);
  });
});

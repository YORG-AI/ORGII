/**
 * Tests for canvasPreviewAtomUpdaters — shared atom update and derivation logic.
 */
import { describe, expect, it } from "vitest";

import type { CanvasPreviewEntry } from "@src/store/session/canvasPreviewAtom";

import {
  applyClearCanvasOnSessionSwitch,
  applyDismissCanvasAtNewTurn,
  applyDismissCanvasEntry,
  deriveCanvasOpenedInSimulator,
  deriveCanvasPayloadForSession,
  deriveCanvasTabPayload,
} from "../canvasPreviewAtomUpdaters";

function makeEntry(
  overrides?: Partial<CanvasPreviewEntry>
): CanvasPreviewEntry {
  return {
    sessionId: "session-1",
    payload: {
      mode: "html",
      content: "<div>hello</div>",
      eventId: "tool-call-abc",
    },
    ...overrides,
  };
}

describe("applyClearCanvasOnSessionSwitch", () => {
  it("clears the atom when switching from session-A to session-B", () => {
    const entry = makeEntry({ sessionId: "session-a" });
    expect(
      applyClearCanvasOnSessionSwitch(entry, "session-a", "session-b")
    ).toBeNull();
  });

  it("preserves entry when reloading the same session", () => {
    const entry = makeEntry({ sessionId: "session-a" });
    expect(
      applyClearCanvasOnSessionSwitch(entry, "session-a", "session-a")
    ).toBe(entry);
  });

  it("preserves entry when there is no previous session (first load)", () => {
    const entry = makeEntry({ sessionId: "session-a" });
    expect(applyClearCanvasOnSessionSwitch(entry, null, "session-a")).toBe(
      entry
    );
  });

  it("returns null when entry is already null", () => {
    expect(
      applyClearCanvasOnSessionSwitch(null, "session-a", "session-b")
    ).toBeNull();
  });
});

describe("applyDismissCanvasEntry", () => {
  it("soft-dismisses so PinnedActionsBar can show the Canvas pill", () => {
    const entry = makeEntry();
    const result = applyDismissCanvasEntry(entry);
    expect(result?.cardDismissed).toBe(true);
    expect(result?.payload).toEqual(entry.payload);
  });
});

describe("applyDismissCanvasAtNewTurn", () => {
  it("matches dismissCanvasAtNewTurn semantics in useSessionSync", () => {
    const entry = makeEntry({ sessionId: "session-1" });
    const result = applyDismissCanvasAtNewTurn(entry, "session-1");
    expect(result?.cardDismissed).toBe(true);
  });
});

describe("deriveCanvasTabPayload", () => {
  it("returns payload for matching session even when cardDismissed", () => {
    const entry = makeEntry({ cardDismissed: true });
    expect(deriveCanvasTabPayload(entry, "session-1")).toEqual(entry.payload);
  });

  it("returns null for a different session", () => {
    const entry = makeEntry({ sessionId: "session-a" });
    expect(deriveCanvasTabPayload(entry, "session-b")).toBeNull();
  });
});

describe("tab close soft-dismiss integration", () => {
  it("tab close sets cardDismissed instead of clearing the atom", () => {
    const entry = makeEntry({ sessionId: "session-1" });
    const afterTabClose = applyDismissCanvasEntry(entry);

    expect(afterTabClose).not.toBeNull();
    expect(
      deriveCanvasPayloadForSession(afterTabClose, "session-1")
    ).toBeNull();
    expect(deriveCanvasTabPayload(afterTabClose, "session-1")).toEqual(
      entry.payload
    );
    expect(afterTabClose?.cardDismissed).toBe(true);
  });

  it("PinnedActionsBar pill remains available after tab close dismiss", () => {
    const entry = makeEntry({ sessionId: "session-1" });
    const afterTabClose = applyDismissCanvasEntry(entry);
    const showCanvasPill = Boolean(
      afterTabClose?.sessionId === "session-1" && afterTabClose.cardDismissed
    );
    expect(showCanvasPill).toBe(true);
  });
});

describe("deriveCanvasPayloadForSession and deriveCanvasOpenedInSimulator", () => {
  it("delegates inline payload derivation to shared helpers", () => {
    const entry = makeEntry({ openedInSimulator: true });
    expect(deriveCanvasPayloadForSession(entry, "session-1")).toEqual(
      entry.payload
    );
    expect(deriveCanvasOpenedInSimulator(entry, "session-1")).toBe(true);
  });
});

/**
 * Tests for useCanvasForTurn state derivations.
 *
 * All logic is tested as pure functions that mirror the hook's atom-update
 * and derivation logic, following the project pattern of extracting testable
 * logic from hooks.
 *
 * Covers:
 * - State machine: idle → ready → dismissed → cleared
 * - Multi-turn isolation: turn N canvas does not bleed into turn N+1
 * - Cross-session isolation: session-A canvas does not affect session-B
 * - openedInSimulator flag semantics
 * - dismiss is idempotent
 * - clearCanvas resets to null
 * - New round visibility after dismiss + new render_inline_canvas
 */
import { describe, expect, it } from "vitest";

import type { CanvasPreviewEntry } from "@src/store/session/canvasPreviewAtom";

import {
  applyDismissCanvasAtNewTurn,
  applyDismissCanvasEntry,
  deriveCanvasOpenedInSimulator,
  deriveCanvasPayloadForSession,
} from "../canvasPreviewAtomUpdaters";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Pure implementation of useCanvasForTurn's payload derivation.
 */
const derivePayload = deriveCanvasPayloadForSession;

/**
 * Pure implementation of useCanvasForTurn's openedInSimulator derivation.
 */
const deriveOpenedInSimulator = deriveCanvasOpenedInSimulator;

/**
 * Pure implementation of the dismiss updater.
 */
const applyDismiss = applyDismissCanvasEntry;

/**
 * Pure implementation of the dismissCanvasAtNewTurn guard.
 */
const applyDismissAtNewTurn = applyDismissCanvasAtNewTurn;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useCanvasForTurn — payload derivation", () => {
  it("returns payload for matching session with no dismissal", () => {
    const entry = makeEntry();
    expect(derivePayload(entry, "session-1")).toEqual(entry.payload);
  });

  it("returns null when entry is null (idle state)", () => {
    expect(derivePayload(null, "session-1")).toBeNull();
  });

  it("returns null when sessionId is null (non-streaming guard)", () => {
    const entry = makeEntry();
    expect(derivePayload(entry, null)).toBeNull();
  });

  it("returns null when sessionId is undefined", () => {
    const entry = makeEntry();
    expect(derivePayload(entry, undefined)).toBeNull();
  });

  it("returns null when sessionId does not match (cross-session isolation)", () => {
    const entry = makeEntry({ sessionId: "session-1" });
    expect(derivePayload(entry, "session-2")).toBeNull();
  });

  it("returns null when canvas is dismissed (ready → dismissed transition)", () => {
    const entry = makeEntry({ cardDismissed: true });
    expect(derivePayload(entry, "session-1")).toBeNull();
  });

  it("returns payload when openedInSimulator is set (that flag only gates the jump button)", () => {
    const entry = makeEntry({ openedInSimulator: true });
    expect(derivePayload(entry, "session-1")).toEqual(entry.payload);
  });
});

describe("useCanvasForTurn — openedInSimulator derivation", () => {
  it("returns false when entry is null", () => {
    expect(deriveOpenedInSimulator(null, "session-1")).toBe(false);
  });

  it("returns false when sessionId does not match", () => {
    const entry = makeEntry({
      sessionId: "session-1",
      openedInSimulator: true,
    });
    expect(deriveOpenedInSimulator(entry, "session-2")).toBe(false);
  });

  it("returns false when openedInSimulator is not set", () => {
    const entry = makeEntry({ sessionId: "session-1" });
    expect(deriveOpenedInSimulator(entry, "session-1")).toBe(false);
  });

  it("returns true when sessionId matches and openedInSimulator is true", () => {
    const entry = makeEntry({
      sessionId: "session-1",
      openedInSimulator: true,
    });
    expect(deriveOpenedInSimulator(entry, "session-1")).toBe(true);
  });
});

describe("useCanvasForTurn — dismiss action", () => {
  it("sets cardDismissed: true on existing entry", () => {
    const entry = makeEntry();
    const result = applyDismiss(entry);
    expect(result?.cardDismissed).toBe(true);
  });

  it("preserves all other fields after dismiss", () => {
    const entry = makeEntry({ openedInSimulator: true });
    const result = applyDismiss(entry);
    expect(result?.sessionId).toBe("session-1");
    expect(result?.payload).toEqual(entry.payload);
    expect(result?.openedInSimulator).toBe(true);
  });

  it("is idempotent — double-dismiss is a no-op (same shape)", () => {
    const entry = makeEntry();
    const once = applyDismiss(entry)!;
    const twice = applyDismiss(once)!;
    expect(twice.cardDismissed).toBe(true);
    expect(twice.sessionId).toBe("session-1");
  });

  it("returns null when called with null entry", () => {
    expect(applyDismiss(null)).toBeNull();
  });
});

describe("useCanvasForTurn — dismissAtNewTurn (new round start)", () => {
  it("sets cardDismissed: true for the matching session", () => {
    const entry = makeEntry({ sessionId: "session-1" });
    const result = applyDismissAtNewTurn(entry, "session-1");
    expect(result?.cardDismissed).toBe(true);
  });

  it("does not modify entry for a different session", () => {
    const entry = makeEntry({ sessionId: "session-1" });
    const result = applyDismissAtNewTurn(entry, "session-2");
    expect(result).toBe(entry);
  });

  it("does not modify an already-dismissed entry (idempotent guard)", () => {
    const entry = makeEntry({ cardDismissed: true });
    const result = applyDismissAtNewTurn(entry, "session-1");
    expect(result).toBe(entry);
  });

  it("returns null when called with null entry", () => {
    expect(applyDismissAtNewTurn(null, "session-1")).toBeNull();
  });
});

describe("useCanvasForTurn — state machine transitions", () => {
  it("idle → ready: new render_inline_canvas creates a visible entry", () => {
    const entry: CanvasPreviewEntry = {
      sessionId: "session-1",
      payload: { mode: "html", content: "<p>canvas</p>", eventId: "tc-1" },
    };
    expect(derivePayload(entry, "session-1")).toEqual(entry.payload);
  });

  it("ready → dismissed: dismiss hides payload", () => {
    const ready = makeEntry();
    const dismissed = applyDismiss(ready)!;
    expect(derivePayload(dismissed, "session-1")).toBeNull();
  });

  it("dismissed → cleared: null entry hides all state", () => {
    // clearCanvas sets the atom to null
    expect(derivePayload(null, "session-1")).toBeNull();
    expect(deriveOpenedInSimulator(null, "session-1")).toBe(false);
  });

  it("dismissed → new turn → new canvas visible: dismiss + new entry = visible", () => {
    const prior = makeEntry({
      cardDismissed: true,
      payload: { mode: "html", content: "<p>old</p>", eventId: "tc-old" },
    });
    expect(derivePayload(prior, "session-1")).toBeNull();

    // New render_inline_canvas replaces the atom entry (no cardDismissed)
    const fresh: CanvasPreviewEntry = {
      sessionId: "session-1",
      payload: { mode: "a2ui", content: '{"type":"text"}', eventId: "tc-new" },
    };
    expect(derivePayload(fresh, "session-1")).toEqual(fresh.payload);
  });
});

describe("useCanvasForTurn — multi-turn isolation", () => {
  it("canvas from turn N does not affect turn N+1's payload when eventId differs", () => {
    const turnNEntry: CanvasPreviewEntry = {
      sessionId: "session-1",
      payload: { mode: "html", content: "<p>turn3</p>", eventId: "tc-turn3" },
    };
    // After turn N+1 starts, dismissCanvasAtNewTurn fires
    const afterNewTurn = applyDismissAtNewTurn(turnNEntry, "session-1");
    expect(derivePayload(afterNewTurn, "session-1")).toBeNull();

    // Turn N+1 render_inline_canvas replaces entry entirely
    const turnN1Entry: CanvasPreviewEntry = {
      sessionId: "session-1",
      payload: { mode: "html", content: "<p>turn5</p>", eventId: "tc-turn5" },
    };
    expect(derivePayload(turnN1Entry, "session-1")).toEqual(
      turnN1Entry.payload
    );
  });
});

describe("useCanvasForTurn — cross-session isolation", () => {
  it("session-A canvas does not leak into session-B", () => {
    const entryA = makeEntry({ sessionId: "session-A" });
    expect(derivePayload(entryA, "session-B")).toBeNull();
    expect(deriveOpenedInSimulator(entryA, "session-B")).toBe(false);
  });

  it("dismissing session-A canvas does not affect session-B payload derivation", () => {
    const entryA = makeEntry({ sessionId: "session-A" });
    const dismissed = applyDismiss(entryA)!;
    // If session-B somehow reads the atom after session-A dismissal (impossible
    // in practice since we only store one entry, but the derivation must be safe)
    expect(derivePayload(dismissed, "session-B")).toBeNull();
  });

  it("dismissAtNewTurn for session-A does not modify session-B entry", () => {
    const entryB = makeEntry({ sessionId: "session-B" });
    const result = applyDismissAtNewTurn(entryB, "session-A");
    expect(result).toBe(entryB);
    expect(result?.cardDismissed).toBeUndefined();
  });
});

describe("useCanvasForTurn — malformed / edge-case payload handling", () => {
  it("entry with empty eventId still returns payload", () => {
    const entry = makeEntry({
      payload: { mode: "html", content: "<p>x</p>", eventId: "" },
    });
    expect(derivePayload(entry, "session-1")).toEqual(entry.payload);
  });

  it("entry with no content (url mode) still returns payload", () => {
    const entry = makeEntry({
      payload: { mode: "url", url: "https://example.com" },
    });
    expect(derivePayload(entry, "session-1")).toEqual(entry.payload);
  });

  it("entry with neither content nor url (streaming = true) still returns payload", () => {
    const entry = makeEntry({ payload: { mode: "a2ui", streaming: true } });
    expect(derivePayload(entry, "session-1")).toEqual(entry.payload);
  });
});

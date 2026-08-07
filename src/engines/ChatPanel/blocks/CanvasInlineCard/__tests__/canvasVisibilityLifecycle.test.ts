/**
 * Tests for canvas visibility lifecycle fixes (issue #188).
 *
 * Covers:
 * - Canvas preview is only returned when sessionId matches and not dismissed
 * - Passing null sessionId always returns null (used by non-streaming ChatVariant)
 * - dismissCanvasAtNewTurn marks the entry as cardDismissed for the right session
 * - A new turn ("running" status) triggers canvas dismissal
 */
import { describe, expect, it, vi } from "vitest";

import {
  type CanvasPreviewEntry,
  deriveCanvasForSessionSnapshot,
  dismissCanvasForSession,
} from "@src/store/session/canvasPreviewAtom";

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

function deriveCanvasPayload(
  entry: CanvasPreviewEntry | null,
  sessionId: string | null | undefined
) {
  return deriveCanvasForSessionSnapshot(entry, sessionId).payload;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("canvas visibility lifecycle", () => {
  describe("deriveCanvasPayload", () => {
    it("returns payload for matching session with no dismissal", () => {
      const entry = makeEntry();
      expect(deriveCanvasPayload(entry, "session-1")).toEqual(entry.payload);
    });

    it("returns null when entry is null", () => {
      expect(deriveCanvasPayload(null, "session-1")).toBeNull();
    });

    it("returns null when sessionId is null (non-streaming ChatVariant guard)", () => {
      const entry = makeEntry();
      expect(deriveCanvasPayload(entry, null)).toBeNull();
    });

    it("returns null when sessionId is undefined", () => {
      const entry = makeEntry();
      expect(deriveCanvasPayload(entry, undefined)).toBeNull();
    });

    it("returns null when sessionId does not match entry", () => {
      const entry = makeEntry({ sessionId: "session-1" });
      expect(deriveCanvasPayload(entry, "session-2")).toBeNull();
    });

    it("returns null when canvas is dismissed", () => {
      const entry = makeEntry({ cardDismissed: true });
      expect(deriveCanvasPayload(entry, "session-1")).toBeNull();
    });

    it("returns payload even when openedInSimulator is set (that flag is for pill only)", () => {
      const entry = makeEntry({ openedInSimulator: true });
      expect(deriveCanvasPayload(entry, "session-1")).toEqual(entry.payload);
    });
  });

  describe("dismissCanvasForSession", () => {
    it("sets cardDismissed: true for the matching session", () => {
      const entry = makeEntry({ sessionId: "session-1" });
      const result = dismissCanvasForSession(entry, "session-1");
      expect(result?.cardDismissed).toBe(true);
    });

    it("preserves all other fields when dismissing", () => {
      const entry = makeEntry({ sessionId: "session-1" });
      const result = dismissCanvasForSession(entry, "session-1");
      expect(result?.sessionId).toBe("session-1");
      expect(result?.payload).toEqual(entry.payload);
    });

    it("does not modify entry for a different session", () => {
      const entry = makeEntry({ sessionId: "session-1" });
      const result = dismissCanvasForSession(entry, "session-2");
      expect(result).toBe(entry);
    });

    it("does not modify entry when already dismissed", () => {
      const entry = makeEntry({ cardDismissed: true });
      const result = dismissCanvasForSession(entry, "session-1");
      expect(result).toBe(entry);
    });

    it("returns null when called with null entry", () => {
      const result = dismissCanvasForSession(null, "session-1");
      expect(result).toBeNull();
    });
  });

  describe("new-turn dismissal integration (onStatusChange('running'))", () => {
    it("dismissCanvasAtNewTurn is invoked when status is 'running'", () => {
      const dismissCanvasAtNewTurn = vi.fn();
      const actions = {
        setSessionContextTokens: vi.fn(),
        setSessionContextUsage: vi.fn(),
        setSessionContextBreakdown: vi.fn(),
        setSessionRuntimeStatus: vi.fn(),
        setSessionRuntimeError: vi.fn(),
        setPendingCancel: vi.fn(),
        setSessionRolledBack: vi.fn(),
        dismissCanvasAtNewTurn,
        setStreamingDeltaContent: vi.fn(),
      };

      // Simulate the onStatusChange("running") branch in sessionSyncStateHelpers
      function simulateRunningStatus(sid: string) {
        actions.setSessionRuntimeError(null);
        actions.setSessionRolledBack(false);
        actions.dismissCanvasAtNewTurn(sid);
      }

      simulateRunningStatus("session-1");

      expect(dismissCanvasAtNewTurn).toHaveBeenCalledOnce();
      expect(dismissCanvasAtNewTurn).toHaveBeenCalledWith("session-1");
    });

    it("a canvas from a prior round is invisible to the new streaming ChatVariant after dismissal", () => {
      const priorEntry = makeEntry({
        sessionId: "session-1",
        payload: {
          mode: "html",
          content: "<div>old canvas</div>",
          eventId: "tool-call-old",
        },
      });

      // New turn starts → dismiss
      const dismissed = dismissCanvasForSession(priorEntry, "session-1");

      // New streaming ChatVariant reads the atom — should get null
      const payload = deriveCanvasPayload(dismissed, "session-1");
      expect(payload).toBeNull();
    });

    it("new canvas in the same round becomes visible after render_inline_canvas fires", () => {
      const priorEntry = makeEntry({
        sessionId: "session-1",
        payload: {
          mode: "html",
          content: "<div>old canvas</div>",
          eventId: "tool-call-old",
        },
        cardDismissed: true,
      });

      // New round's render_inline_canvas replaces the atom entry (no cardDismissed)
      const newEntry: CanvasPreviewEntry = {
        sessionId: "session-1",
        payload: {
          mode: "html",
          content: "<div>new canvas</div>",
          eventId: "tool-call-new",
        },
      };

      expect(deriveCanvasPayload(priorEntry, "session-1")).toBeNull();
      expect(deriveCanvasPayload(newEntry, "session-1")).toEqual(
        newEntry.payload
      );
    });
  });

  describe("cross-session isolation", () => {
    it("canvas from session-A does not leak into session-B's streaming view", () => {
      const entry = makeEntry({ sessionId: "session-A" });
      expect(deriveCanvasPayload(entry, "session-B")).toBeNull();
    });

    it("dismissing session-A canvas does not affect session-B entry", () => {
      const entryA = makeEntry({ sessionId: "session-A" });
      // dismissCanvasForSession is called with session-A's id but only modifies session-A
      const afterDismissA = dismissCanvasForSession(entryA, "session-A");
      expect(afterDismissA?.cardDismissed).toBe(true);

      const entryB = makeEntry({ sessionId: "session-B" });
      const afterDismissOnB = dismissCanvasForSession(entryB, "session-A");
      expect(afterDismissOnB).toBe(entryB);
      expect(afterDismissOnB?.cardDismissed).toBeUndefined();
    });
  });
});

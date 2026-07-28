import { describe, expect, it } from "vitest";

import {
  SESSION_VIEW_MODES,
  type SessionViewMode,
  type SessionViewModeState,
  isSessionViewMode,
  resolveSessionViewMode,
} from "./useSessionViewMode";

function state(
  mode: SessionViewMode,
  sessionId: string | null
): SessionViewModeState {
  return { mode, sessionId };
}

describe("resolveSessionViewMode", () => {
  it("keeps the stored mode for the session it was stored against", () => {
    expect(resolveSessionViewMode(state("raw", "s-1"), "s-1", true)).toBe(
      "raw"
    );
  });

  it("falls back to gui when the stored entry belongs to another session", () => {
    // Regression: opening Raw on one session and then switching tabs must not
    // strand the newly-opened session in Raw.
    expect(resolveSessionViewMode(state("raw", "s-1"), "s-2", true)).toBe(
      "gui"
    );
  });

  it("pins non-switchable sessions to gui even with a matching raw entry", () => {
    // Human sessions have no agent transcript to serialize.
    expect(resolveSessionViewMode(state("raw", "s-1"), "s-1", false)).toBe(
      "gui"
    );
  });

  it("resolves to gui when there is no active session", () => {
    expect(resolveSessionViewMode(state("raw", null), null, false)).toBe("gui");
  });
});

describe("isSessionViewMode", () => {
  it("accepts every supported mode", () => {
    expect(SESSION_VIEW_MODES.every(isSessionViewMode)).toBe(true);
  });

  it("rejects anything else so a stray select value cannot write bad state", () => {
    expect(isSessionViewMode("tree")).toBe(false);
    expect(isSessionViewMode("")).toBe(false);
  });
});

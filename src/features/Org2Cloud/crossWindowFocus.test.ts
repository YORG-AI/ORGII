import { describe, expect, it } from "vitest";

import { isWindowFocused } from "@src/util/core/windowFocus";

import {
  CROSS_WINDOW_FOCUS_TTL_MS,
  aggregateCrossWindowFocus,
  isAnyAppWindowFocused,
  parseCrossWindowFocusMap,
} from "./crossWindowFocus";

describe("aggregateCrossWindowFocus (staleness/aggregation core)", () => {
  const now = 1_000_000;

  it("own focus wins regardless of peers", () => {
    expect(aggregateCrossWindowFocus(true, [], now)).toBe(true);
    expect(
      aggregateCrossWindowFocus(
        true,
        [{ focused: false, at: now - CROSS_WINDOW_FOCUS_TTL_MS * 10 }],
        now
      )
    ).toBe(true);
  });

  it("a fresh focused peer keeps the app foregrounded", () => {
    expect(
      aggregateCrossWindowFocus(
        false,
        [{ focused: true, at: now - 1_000 }],
        now
      )
    ).toBe(true);
  });

  it("a focused claim exactly TTL old still counts; one past it does not", () => {
    expect(
      aggregateCrossWindowFocus(
        false,
        [{ focused: true, at: now - CROSS_WINDOW_FOCUS_TTL_MS }],
        now
      )
    ).toBe(true);
    expect(
      aggregateCrossWindowFocus(
        false,
        [{ focused: true, at: now - CROSS_WINDOW_FOCUS_TTL_MS - 1 }],
        now
      )
    ).toBe(false);
  });

  it("fresh but unfocused peers never count", () => {
    expect(
      aggregateCrossWindowFocus(false, [{ focused: false, at: now }], now)
    ).toBe(false);
  });

  it("no peers and no own focus means background", () => {
    expect(aggregateCrossWindowFocus(false, [], now)).toBe(false);
  });

  it("one live focused peer among stale/unfocused ones is enough", () => {
    expect(
      aggregateCrossWindowFocus(
        false,
        [
          { focused: false, at: now },
          { focused: true, at: now - CROSS_WINDOW_FOCUS_TTL_MS * 2 },
          { focused: true, at: now - 2_000 },
        ],
        now
      )
    ).toBe(true);
  });
});

describe("parseCrossWindowFocusMap", () => {
  it("parses a valid map and drops malformed entries", () => {
    const raw = JSON.stringify({
      main: { focused: true, at: 123 },
      "app-window-session-1": { focused: false, at: 456 },
      "bad-focused": { focused: "yes", at: 1 },
      "bad-at": { focused: true, at: "soon" },
      "bad-shape": 42,
    });
    expect(parseCrossWindowFocusMap(raw)).toEqual({
      main: { focused: true, at: 123 },
      "app-window-session-1": { focused: false, at: 456 },
    });
  });

  it("degrades to empty for null, broken JSON, and non-object roots", () => {
    expect(parseCrossWindowFocusMap(null)).toEqual({});
    expect(parseCrossWindowFocusMap("")).toEqual({});
    expect(parseCrossWindowFocusMap("{not json")).toEqual({});
    expect(parseCrossWindowFocusMap('"a string"')).toEqual({});
    expect(parseCrossWindowFocusMap("[1,2]")).toEqual({});
  });
});

describe("isAnyAppWindowFocused outside Tauri", () => {
  it("collapses to plain own-window focus (single document)", () => {
    // Non-Tauri environments have no peer windows; the lease's existing
    // single-window semantics must be exactly preserved.
    expect(isAnyAppWindowFocused()).toBe(isWindowFocused());
  });
});

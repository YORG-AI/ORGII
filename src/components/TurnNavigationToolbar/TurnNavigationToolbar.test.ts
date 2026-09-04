import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import { formatTranscriptRoundTimeLabel } from "./formatTranscriptRoundTimeLabel";
import { shouldShowTurnPaginationSpinner } from "./shouldShowTurnPaginationSpinner";
import { getTurnNavigationLabel } from "./turnNavigationLabels";

describe("getTurnNavigationLabel", () => {
  const t = vi.fn((key: string, values?: { current?: number }) => {
    if (key === "pagination.latestRound") return "Latest round";
    if (key === "pagination.round") return `Round ${values?.current}`;
    return key;
  }) as unknown as TFunction;

  it("shows latest while hydrating or on the tail page", () => {
    expect(
      getTurnNavigationLabel({
        ready: false,
        currentIndex: 0,
        pageCount: 3,
        t,
      })
    ).toBe("Latest round");
    expect(
      getTurnNavigationLabel({
        ready: true,
        currentIndex: 2,
        pageCount: 3,
        t,
      })
    ).toBe("Latest round");
  });

  it("shows the numbered round label for earlier pages", () => {
    expect(
      getTurnNavigationLabel({
        ready: true,
        currentIndex: 0,
        pageCount: 3,
        t,
      })
    ).toBe("Round 1");
  });
});

describe("formatTranscriptRoundTimeLabel", () => {
  it("formats a single timestamp for short ranges", () => {
    const label = formatTranscriptRoundTimeLabel({
      startedAt: "2026-09-03T10:44:00.000Z",
      endedAt: "2026-09-03T10:44:30.000Z",
    });
    expect(label).toMatch(/\d{2}:\d{2}/);
    expect(label).not.toContain("~");
  });
});

describe("shouldShowTurnPaginationSpinner", () => {
  it("does not animate a stable empty session", () => {
    expect(
      shouldShowTurnPaginationSpinner({
        turnPaginationReady: false,
        pageCount: 0,
      })
    ).toBe(false);
  });

  it("animates while an existing round is still hydrating", () => {
    expect(
      shouldShowTurnPaginationSpinner({
        turnPaginationReady: false,
        pageCount: 1,
      })
    ).toBe(true);
  });
});

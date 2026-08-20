// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";

import SessionTimelineView from "./SessionTimelineView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: "en-US" },
    t: (_key: string, options?: Record<string, string | number>) =>
      Object.entries(options ?? {}).reduce(
        (label, [name, value]) => label.replace(`{{${name}}}`, String(value)),
        String(options?.defaultValue ?? _key)
      ),
  }),
}));

vi.mock("@src/components/TreeRow", () => ({
  VirtualizedListBase: <T>({
    items,
    itemHeight,
    paddingTop,
    computeItemKey,
    renderItem,
  }: {
    items: T[];
    itemHeight: number;
    paddingTop?: number;
    computeItemKey: (item: T, index: number) => string | number;
    renderItem: (item: T, index: number) => React.ReactNode;
  }) =>
    React.createElement(
      "div",
      {
        "data-testid": "virtualized-timeline-list",
        "data-item-count": items.length,
        "data-item-height": itemHeight,
        "data-padding-top": paddingTop,
      },
      ...items.map((item, index) =>
        React.createElement(
          React.Fragment,
          { key: computeItemKey(item, index) },
          renderItem(item, index)
        )
      )
    ),
}));

function turn(index: number): TurnSummary {
  const startedAt = new Date(Date.UTC(2026, 7, 14, 0, index)).toISOString();
  const endedAt = new Date(Date.UTC(2026, 7, 14, 0, index, 1)).toISOString();

  return {
    sessionId: "session-1",
    turnId: `turn-${index + 1}`,
    startSequence: index * 2 + 1,
    endSequence: index * 2 + 2,
    nextTurnId: null,
    startedAt,
    endedAt,
    durationMs: 1_000,
    userEventIds: [],
    userPreview: `Turn ${index + 1}`,
    eventCount: 1,
    bodyEventCount: 1,
    status: "completed",
    interrupted: false,
    modifiedFiles: [],
    resourceInteractions: [],
    gitArtifacts: [],
  };
}

function turnWithoutEnd(index: number): TurnSummary {
  return {
    ...turn(index),
    endedAt: null,
    durationMs: null,
  };
}

describe("SessionTimelineView", () => {
  it("reserves overlay chrome outside the virtualized list so the first round stays visible", () => {
    document.body.innerHTML = renderToStaticMarkup(
      React.createElement(SessionTimelineView, {
        turns: Array.from({ length: 7 }, (_, index) => turn(index)),
        loading: false,
        error: null,
        topInset: 84,
      })
    );

    const view = document.querySelector(
      '[data-testid="session-timeline-view"]'
    );
    const summary = document.querySelector(
      '[data-testid="session-timeline-view-summary"]'
    );
    const list = document.querySelector(
      '[data-testid="virtualized-timeline-list"]'
    );
    const rows = document.querySelectorAll(
      '[data-testid="session-timeline-row"]'
    );

    expect(view?.getAttribute("style")).toContain("padding-top:84px");
    expect(summary?.className).not.toContain("absolute");
    expect(list?.getAttribute("data-item-count")).toBe("7");
    expect(list?.hasAttribute("data-padding-top")).toBe(false);
    expect(rows).toHaveLength(7);
    expect(rows[0]?.textContent).toContain("#1");
    const ranges = document.querySelectorAll(
      '[data-testid="session-timeline-range"]'
    );
    expect(ranges).toHaveLength(7);
    expect(ranges[0]?.textContent).toContain(" ~ ");
    expect(ranges[0]?.getAttribute("data-start-ms")).toBe(
      String(Date.parse("2026-08-14T00:00:00.000Z"))
    );
    expect(ranges[0]?.getAttribute("data-end-ms")).toBe(
      String(Date.parse("2026-08-14T00:00:01.000Z"))
    );
  });

  it("uses a tilde between the start and end times", () => {
    document.body.innerHTML = renderToStaticMarkup(
      React.createElement(SessionTimelineView, {
        turns: [turnWithoutEnd(0), turnWithoutEnd(1)],
        loading: false,
        error: null,
      })
    );

    const ranges = document.querySelectorAll(
      '[data-testid="session-timeline-range"]'
    );
    expect(ranges[0]?.textContent).toContain(" ~ ");
    expect(ranges[1]?.textContent).toContain(" ~ —");
  });
});

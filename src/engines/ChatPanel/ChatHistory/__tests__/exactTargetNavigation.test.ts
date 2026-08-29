import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  resolveExactHistoryTarget,
  resolveExactHistoryTargetDisplayIndex,
  resolveExactHistoryTargetFlatIndex,
} from "../exactTargetNavigation";

const event = (id: string) => ({ id }) as SessionEvent;

describe("exact history target navigation", () => {
  const originalToFlatIndex = new Map([
    [0, 0],
    [1, 3],
    [2, 8],
  ]);

  it("maps a plain projected event through the projection index", () => {
    expect(
      resolveExactHistoryTargetFlatIndex(
        [{ chunk_id: "one", type: "activity", event: event("one") }],
        new Map([[0, 4]]),
        "one"
      )
    ).toBe(4);
  });

  it("keeps a user header target distinct from the first body row", () => {
    const header = {
      chunk_id: "header",
      type: "activity",
      event: event("user-anchor"),
    } as never;
    const body = {
      chunk_id: "body",
      type: "activity",
      event: event("body-event"),
    } as never;
    expect(
      resolveExactHistoryTarget(
        [header, body],
        [header],
        [1],
        new Map([
          [0, 0],
          [1, 0],
        ]),
        "user-anchor"
      )
    ).toEqual({ kind: "header", groupIndex: 0, groupId: "user-anchor" });
    expect(
      resolveExactHistoryTarget(
        [header, body],
        [header],
        [1],
        new Map([
          [0, 0],
          [1, 0],
        ]),
        "body-event"
      )
    ).toEqual({ kind: "body", flatIndex: 0, groupIndex: 0 });
  });

  it("maps consolidated and grouped nested events to their owning display row", () => {
    const items = [
      {
        chunk_id: "consolidated",
        type: "activity",
        consolidatedParts: 2,
        event: event("consolidated-tail"),
        consolidatedEvents: [
          event("consolidated-first"),
          event("consolidated-second"),
        ],
      },
      {
        chunk_id: "summary",
        type: "actionSummaryGroup",
        actionSummaryItems: [
          { category: "read", event: event("nested-summary") },
        ],
      },
      {
        chunk_id: "stack",
        type: "activityStackGroup",
        activityStackGroup: {
          category: "browser",
          events: [event("nested-stack")],
        },
      },
    ] as never;

    expect(
      resolveExactHistoryTargetFlatIndex(
        items,
        originalToFlatIndex,
        "consolidated-second"
      )
    ).toBe(0);
    expect(
      resolveExactHistoryTargetFlatIndex(
        items,
        originalToFlatIndex,
        "nested-summary"
      )
    ).toBe(3);
    expect(
      resolveExactHistoryTargetFlatIndex(
        items,
        originalToFlatIndex,
        "nested-stack"
      )
    ).toBe(8);
  });

  it("does not invent a target when filtering removed the durable event", () => {
    expect(
      resolveExactHistoryTargetFlatIndex(
        [{ chunk_id: "visible", type: "activity", event: event("visible") }],
        new Map([[0, 0]]),
        "filtered-out"
      )
    ).toBeNull();
  });

  it("converts a global target to the selected page-local offset", () => {
    const pages = [
      {
        startGroupIndex: 0,
        endGroupIndex: 0,
        flatStartIndex: 0,
        flatEndIndex: 3,
        cursorIdeSummary: null,
      },
      {
        startGroupIndex: 1,
        endGroupIndex: 1,
        flatStartIndex: 3,
        flatEndIndex: 9,
        cursorIdeSummary: null,
      },
    ];

    expect(resolveExactHistoryTargetDisplayIndex(8, pages, 1, true)).toBe(5);
    expect(resolveExactHistoryTargetDisplayIndex(8, pages, 0, true)).toBeNull();
    expect(resolveExactHistoryTargetDisplayIndex(8, pages, 0, false)).toBe(8);
  });
});

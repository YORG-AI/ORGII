import { describe, expect, it } from "vitest";

import type { LocalChannelMessage } from "@src/store/ui/localChannelMessagesAtom";

import {
  CHANNEL_MESSAGE_GROUPING_WINDOW_MS,
  buildChannelFeedRows,
  resolveChannelDateDividerLabel,
} from "./channelFeedRows";

/** Local-noon timestamps keep the calendar-day assertions offset-proof. */
function localIso(
  year: number,
  month: number,
  day: number,
  minute = 0
): string {
  return new Date(year, month - 1, day, 12, minute).toISOString();
}

function makeMessage(
  overrides: Partial<LocalChannelMessage> = {}
): LocalChannelMessage {
  return {
    id: "msg-1",
    channelId: "chan-1",
    body: "code-review is green",
    createdAt: localIso(2026, 7, 31),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("buildChannelFeedRows", () => {
  it("returns nothing for an empty transcript", () => {
    expect(buildChannelFeedRows([])).toEqual([]);
  });

  it("opens each calendar day with a divider row", () => {
    const rows = buildChannelFeedRows([
      makeMessage({ id: "a", createdAt: localIso(2026, 7, 30) }),
      makeMessage({ id: "b", createdAt: localIso(2026, 7, 31) }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      "divider",
      "message",
      "divider",
      "message",
    ]);
  });

  it("emits one divider for several messages on the same day", () => {
    const rows = buildChannelFeedRows([
      makeMessage({ id: "a", createdAt: localIso(2026, 7, 31, 0) }),
      makeMessage({ id: "b", createdAt: localIso(2026, 7, 31, 1) }),
    ]);
    expect(rows.filter((row) => row.kind === "divider")).toHaveLength(1);
  });

  it("groups a message posted inside the grouping window", () => {
    const rows = buildChannelFeedRows([
      makeMessage({ id: "a", createdAt: localIso(2026, 7, 31, 0) }),
      makeMessage({ id: "b", createdAt: localIso(2026, 7, 31, 1) }),
    ]);
    expect(rows[1]).toMatchObject({ id: "a", grouped: false });
    expect(rows[2]).toMatchObject({ id: "b", grouped: true });
  });

  it("breaks the group once the window elapses", () => {
    const start = new Date(2026, 6, 31, 12, 0).getTime();
    const rows = buildChannelFeedRows([
      makeMessage({ id: "a", createdAt: new Date(start).toISOString() }),
      makeMessage({
        id: "b",
        createdAt: new Date(
          start + CHANNEL_MESSAGE_GROUPING_WINDOW_MS + 1000
        ).toISOString(),
      }),
    ]);
    expect(rows[2]).toMatchObject({ id: "b", grouped: false });
  });

  it("never groups the first message after a divider", () => {
    const rows = buildChannelFeedRows([
      makeMessage({ id: "a", createdAt: localIso(2026, 7, 30, 59) }),
      makeMessage({ id: "b", createdAt: localIso(2026, 7, 31, 0) }),
    ]);
    expect(rows[3]).toMatchObject({ id: "b", grouped: false });
  });

  it("never groups a tombstone into the block above it", () => {
    const rows = buildChannelFeedRows([
      makeMessage({ id: "a", createdAt: localIso(2026, 7, 31, 0) }),
      makeMessage({
        id: "b",
        body: "",
        createdAt: localIso(2026, 7, 31, 1),
        deletedAt: localIso(2026, 7, 31, 2),
      }),
    ]);
    expect(rows[2]).toMatchObject({ id: "b", grouped: false });
  });

  it("keeps divider ids stable per calendar day", () => {
    const rows = buildChannelFeedRows([
      makeMessage({ createdAt: localIso(2026, 7, 31) }),
    ]);
    expect(rows[0]).toMatchObject({
      kind: "divider",
      id: "divider-2026-07-31",
      dateKey: "2026-07-31",
    });
  });
});

describe("resolveChannelDateDividerLabel", () => {
  const now = new Date(2026, 6, 31, 12, 0);

  it("labels the current calendar day as today", () => {
    expect(resolveChannelDateDividerLabel("2026-07-31", now)).toEqual({
      kind: "today",
    });
  });

  it("labels the previous calendar day as yesterday", () => {
    expect(resolveChannelDateDividerLabel("2026-07-30", now)).toEqual({
      kind: "yesterday",
    });
  });

  it("returns the local date for anything older", () => {
    const label = resolveChannelDateDividerLabel("2026-07-20", now);
    expect(label.kind).toBe("date");
    if (label.kind !== "date") throw new Error("expected a date label");
    // Parsed as a LOCAL calendar day, not shifted through UTC midnight.
    expect(label.date.getFullYear()).toBe(2026);
    expect(label.date.getMonth()).toBe(6);
    expect(label.date.getDate()).toBe(20);
  });
});

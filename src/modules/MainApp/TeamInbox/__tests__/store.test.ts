import { describe, expect, it } from "vitest";

import {
  MAX_TEAM_INBOX_CLOUD_READ_RECEIPTS,
  addTeamInboxCloudReadReceipts,
  removeTeamInboxCloudReadReceipts,
} from "../store";

describe("addTeamInboxCloudReadReceipts", () => {
  it("keeps the persisted receipt map bounded", () => {
    const current = Object.fromEntries(
      Array.from({ length: MAX_TEAM_INBOX_CLOUD_READ_RECEIPTS }, (_, index) => [
        `receipt-${index}`,
        new Date(index).toISOString(),
      ])
    );

    const next = addTeamInboxCloudReadReceipts(current, {
      "receipt-new": "2026-07-23T12:00:00.000Z",
    });

    expect(Object.keys(next)).toHaveLength(MAX_TEAM_INBOX_CLOUD_READ_RECEIPTS);
    expect(next).not.toHaveProperty("receipt-0");
    expect(next["receipt-new"]).toBe("2026-07-23T12:00:00.000Z");
  });

  it("refreshes an existing receipt without evicting an extra entry", () => {
    const next = addTeamInboxCloudReadReceipts(
      {
        first: "2026-07-23T10:00:00.000Z",
        second: "2026-07-23T11:00:00.000Z",
      },
      { first: "2026-07-23T12:00:00.000Z" }
    );

    expect(next).toEqual({
      second: "2026-07-23T11:00:00.000Z",
      first: "2026-07-23T12:00:00.000Z",
    });
  });
});

describe("removeTeamInboxCloudReadReceipts", () => {
  it("deletes the given receipt keys", () => {
    const next = removeTeamInboxCloudReadReceipts(
      {
        keep: "2026-07-23T10:00:00.000Z",
        drop: "2026-07-23T11:00:00.000Z",
      },
      ["drop"]
    );

    expect(next).toEqual({ keep: "2026-07-23T10:00:00.000Z" });
  });

  it("returns the same reference when nothing changes", () => {
    const current = { keep: "2026-07-23T10:00:00.000Z" };
    expect(removeTeamInboxCloudReadReceipts(current, [])).toBe(current);
    expect(removeTeamInboxCloudReadReceipts(current, ["missing"])).toBe(
      current
    );
  });
});

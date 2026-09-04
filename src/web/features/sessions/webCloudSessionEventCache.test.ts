import { describe, expect, it } from "vitest";

import type { CloudSessionEventSnapshot } from "./cloudSessionSegments";
import {
  WEB_CLOUD_SESSION_CACHE_MAX_ENTRIES,
  WEB_CLOUD_SESSION_CACHE_MAX_EVENTS,
  WEB_CLOUD_SESSION_CACHE_TTL_MS,
  type WebCloudSessionEventCacheRecord,
  isWebCloudSessionEventCacheRecordUsable,
  webCloudSessionCacheOverflowCount,
} from "./webCloudSessionEventCache";

function record(
  eventCount: number,
  storedAt: number
): WebCloudSessionEventCacheRecord {
  return {
    storedAt,
    snapshot: {
      epoch: 1,
      frozenSeq: eventCount,
      tailHash: "tail",
      count: eventCount,
      segments: [],
      events: Array.from({ length: eventCount }, (_, index) => ({
        id: `event-${index}`,
      })) as unknown as CloudSessionEventSnapshot["events"],
    },
  };
}

describe("isWebCloudSessionEventCacheRecordUsable", () => {
  it("accepts a fresh snapshot within the event bound", () => {
    expect(
      isWebCloudSessionEventCacheRecordUsable(record(2, 1_000), 2_000)
    ).toBe(true);
  });

  it("rejects expired snapshots so reads evict stale identity-scoped data", () => {
    expect(
      isWebCloudSessionEventCacheRecordUsable(
        record(1, 1_000),
        1_000 + WEB_CLOUD_SESSION_CACHE_TTL_MS + 1
      )
    ).toBe(false);
  });

  it("rejects snapshots that exceed the persistent event bound", () => {
    expect(
      isWebCloudSessionEventCacheRecordUsable(
        record(WEB_CLOUD_SESSION_CACHE_MAX_EVENTS + 1, 1_000),
        2_000
      )
    ).toBe(false);
  });
});

describe("webCloudSessionCacheOverflowCount", () => {
  it("evicts only the oldest entries above the persistent entry cap", () => {
    expect(
      webCloudSessionCacheOverflowCount(WEB_CLOUD_SESSION_CACHE_MAX_ENTRIES - 1)
    ).toBe(0);
    expect(
      webCloudSessionCacheOverflowCount(WEB_CLOUD_SESSION_CACHE_MAX_ENTRIES + 3)
    ).toBe(3);
  });
});

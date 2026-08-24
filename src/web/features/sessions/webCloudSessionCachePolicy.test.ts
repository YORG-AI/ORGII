import { describe, expect, it } from "vitest";

import type { CloudSessionEventSnapshot } from "./cloudSessionSegments";
import type { WebSessionListItem } from "./useWebSessionRoster";
import {
  buildWebCloudSessionCacheKey,
  canReadWebCloudSessionEvents,
  isWebCloudSessionCacheFresh,
  shouldFetchWebCloudSessionEvents,
} from "./webCloudSessionCachePolicy";

function snapshot(
  overrides: Partial<CloudSessionEventSnapshot> = {}
): CloudSessionEventSnapshot {
  return {
    epoch: 1,
    frozenSeq: 2,
    tailHash: "tail-a",
    count: 3,
    segments: [],
    events: [],
    ...overrides,
  };
}

function session(
  overrides: Partial<WebSessionListItem> = {}
): WebSessionListItem {
  return {
    id: "session-row-1",
    orgId: "org-1",
    eventsEpoch: 1,
    eventsFrozenSeq: 2,
    eventsCount: 3,
    eventsTailHash: "tail-a",
    ...overrides,
  } as WebSessionListItem;
}

describe("buildWebCloudSessionCacheKey", () => {
  it("scopes cache entries by auth identity and session row", () => {
    const auth = {
      supabaseUrl: "https://cloud.example.com",
      userId: "user-1",
    };
    expect(buildWebCloudSessionCacheKey(auth, session())).toBe(
      "https://cloud.example.com|user-1|org-1|session-row-1"
    );
  });
});

describe("isWebCloudSessionCacheFresh", () => {
  it("rejects cache when the authorization-bearing roster summary is absent", () => {
    expect(
      isWebCloudSessionCacheFresh(
        session({ eventsEpoch: undefined }),
        snapshot()
      )
    ).toBe(false);
  });

  it("rejects cache when epoch or tail hash drift", () => {
    expect(isWebCloudSessionCacheFresh(session(), snapshot({ epoch: 2 }))).toBe(
      false
    );
    expect(
      isWebCloudSessionCacheFresh(session(), snapshot({ tailHash: "tail-b" }))
    ).toBe(false);
  });
});

describe("canReadWebCloudSessionEvents", () => {
  it("requires a published epoch and more than metadata-only access", () => {
    expect(canReadWebCloudSessionEvents(session())).toBe(true);
    expect(
      canReadWebCloudSessionEvents(session({ eventsEpoch: undefined }))
    ).toBe(false);
    expect(
      canReadWebCloudSessionEvents(session({ accessMode: "metadata_only" }))
    ).toBe(false);
  });
});

describe("shouldFetchWebCloudSessionEvents", () => {
  it("skips network when a fresh cache exists unless forced", () => {
    expect(shouldFetchWebCloudSessionEvents(false, snapshot(), session())).toBe(
      false
    );
    expect(shouldFetchWebCloudSessionEvents(true, snapshot(), session())).toBe(
      true
    );
    expect(shouldFetchWebCloudSessionEvents(false, null, session())).toBe(true);
  });

  it("never fetches an unauthorized transcript", () => {
    expect(
      shouldFetchWebCloudSessionEvents(
        true,
        snapshot(),
        session({ accessMode: "metadata_only", eventsEpoch: undefined })
      )
    ).toBe(false);
  });
});

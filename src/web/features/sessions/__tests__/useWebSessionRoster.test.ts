import { describe, expect, it } from "vitest";

import { aggregateWebSessionRoster } from "../useWebSessionRoster";

describe("aggregateWebSessionRoster", () => {
  it("merges ready org rows and marks the roster loaded", () => {
    const result = aggregateWebSessionRoster({
      orgs: [{ orgId: "org-1", name: "Org One", role: "owner" }],
      entries: {
        "org-1": {
          identityKey: "identity-1",
          rows: [
            {
              id: "row-1",
              orgId: "org-1",
              ownerMemberId: "member-1",
              sourceSessionId: "session-1",
              ownerUserId: "user-1",
              ownerDisplayName: "Me",
              ownerIdentityKind: "human",
              title: "Mine",
              lastActivityAt: "2026-08-20T08:00:00.000Z",
              eventsEpoch: 1,
              eventsFrozenSeq: 0,
              eventsCount: 0,
              eventsTailHash: "",
            },
          ],
          state: "ready",
          fetchedAt: 1,
        },
      },
      identityKey: "identity-1",
      userId: "user-1",
    });

    expect(result.status).toBe("loaded");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.orgName).toBe("Org One");
    expect(result.sessions[0]?.writable).toBe(true);
    expect(result.sessionFetchStateByOrg).toEqual({ "org-1": "ready" });
  });

  it("reports loading while every org entry is still idle", () => {
    const result = aggregateWebSessionRoster({
      orgs: [{ orgId: "org-1", name: "Org One", role: "owner" }],
      entries: {
        "org-1": {
          identityKey: "identity-1",
          rows: [],
          state: "idle",
          fetchedAt: 0,
        },
      },
      identityKey: "identity-1",
      userId: "user-1",
    });

    expect(result.status).toBe("loading");
    expect(result.sessions).toEqual([]);
    expect(result.sessionFetchStateByOrg).toEqual({ "org-1": "idle" });
  });

  it("keeps each organization fetch state when another org already has rows", () => {
    const result = aggregateWebSessionRoster({
      orgs: [
        { orgId: "org-loading", name: "Loading", role: "member" },
        { orgId: "org-ready", name: "Ready", role: "owner" },
      ],
      entries: {
        "org-loading": {
          identityKey: "identity-1",
          rows: [],
          state: "loading",
          fetchedAt: 0,
        },
        "org-ready": {
          identityKey: "identity-1",
          rows: [
            {
              id: "row-ready",
              orgId: "org-ready",
              ownerMemberId: "member-1",
              sourceSessionId: "session-ready",
              ownerUserId: "user-1",
              ownerDisplayName: "Me",
              ownerIdentityKind: "human",
              title: "Ready session",
              lastActivityAt: "2026-08-20T08:00:00.000Z",
              eventsEpoch: 1,
              eventsFrozenSeq: 0,
              eventsCount: 0,
              eventsTailHash: "",
            },
          ],
          state: "ready",
          fetchedAt: 1,
        },
      },
      identityKey: "identity-1",
      userId: "user-1",
    });

    expect(result.status).toBe("loaded");
    expect(result.sessionFetchStateByOrg).toEqual({
      "org-loading": "loading",
      "org-ready": "ready",
    });
  });
});

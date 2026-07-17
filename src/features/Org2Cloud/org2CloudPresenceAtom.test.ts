import { describe, expect, it } from "vitest";

import type { Session } from "@src/store/session/sessionAtom/types";

import {
  latestPresenceMeta,
  resolveCloudSessionRefs,
  viewersForSession,
} from "./org2CloudPresenceAtom";

const PRESENCE = {
  "org-1": {
    "user-a": {
      userId: "user-a",
      displayName: "Ada",
      viewingSessionId: "s-1",
    },
    "user-b": {
      userId: "user-b",
      displayName: "Bea",
      viewingSessionId: "s-1",
    },
    "user-c": {
      userId: "user-c",
      displayName: "Cy",
      viewingSessionId: null,
    },
  },
};

describe("viewersForSession", () => {
  it("returns other users viewing the session, excluding self", () => {
    const viewers = viewersForSession(PRESENCE, "org-1", "s-1", "user-a");
    expect(viewers.map((viewer) => viewer.userId)).toEqual(["user-b"]);
  });

  it("returns empty for unknown orgs and non-viewed sessions", () => {
    expect(viewersForSession(PRESENCE, "org-2", "s-1", null)).toEqual([]);
    expect(viewersForSession(PRESENCE, "org-1", "s-9", null)).toEqual([]);
  });

  it("keeps everyone when self is not in the org (null self)", () => {
    const viewers = viewersForSession(PRESENCE, "org-1", "s-1", null);
    expect(viewers).toHaveLength(2);
  });
});

describe("resolveCloudSessionRefs", () => {
  it("maps an owner-side session into every explicitly tagged cloud org", () => {
    const session = { session_id: "session-1" } as Session;

    expect(resolveCloudSessionRefs(session, ["org-a", "org-b"])).toEqual([
      { orgId: "org-a", bareSessionId: "session-1" },
      { orgId: "org-b", bareSessionId: "session-1" },
    ]);
  });

  it("keeps an imported replay scoped to its source even if local tags exist", () => {
    const session = {
      session_id: "imported-1",
      importedFrom: {
        orgId: "source-org",
        sourceSessionId: "source-session",
      },
    } as Session;

    expect(resolveCloudSessionRefs(session, ["unrelated-org"])).toEqual([
      { orgId: "source-org", bareSessionId: "source-session" },
    ]);
  });
});

describe("latestPresenceMeta", () => {
  it("selects the newest re-track meta instead of relying on array order", () => {
    expect(
      latestPresenceMeta([
        { viewingSessionId: null, updatedAt: 10 },
        { viewingSessionId: "session-1", updatedAt: 30 },
        { viewingSessionId: "stale", updatedAt: 20 },
      ])
    ).toMatchObject({ viewingSessionId: "session-1", updatedAt: 30 });
  });

  it("uses the last meta as a deterministic legacy fallback", () => {
    expect(
      latestPresenceMeta([
        { viewingSessionId: null },
        { viewingSessionId: "session-1" },
      ])
    ).toMatchObject({ viewingSessionId: "session-1" });
  });
});

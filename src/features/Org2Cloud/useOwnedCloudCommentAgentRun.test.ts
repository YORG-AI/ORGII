import { describe, expect, it } from "vitest";

import type { Session } from "@src/store/session/sessionAtom/types";

import type { SessionCommentTarget } from "./sessionCommentTarget";
import { canRunOwnedCloudComments } from "./useOwnedCloudCommentAgentRun";

const TARGET: SessionCommentTarget = {
  orgId: "org-1",
  sessionId: "session-1",
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    session_id: "session-1",
    status: "completed",
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("canRunOwnedCloudComments", () => {
  it("allows the owner's writable source and immutable external-history source", () => {
    expect(
      canRunOwnedCloudComments({
        session: session(),
        target: TARGET,
        viewerOwnsSession: true,
      })
    ).toBe(true);
    expect(
      canRunOwnedCloudComments({
        session: session({
          session_id: "codexapp-session-1",
        }),
        target: { ...TARGET, sessionId: "codexapp-session-1" },
        viewerOwnsSession: true,
      })
    ).toBe(true);
  });

  it("allows the owner's verified fork to keep addressing its source", () => {
    expect(
      canRunOwnedCloudComments({
        session: session({
          session_id: "fork-session-1",
          forkedFrom: {
            orgId: "org-1",
            sourceSessionId: "session-1",
            ownerMemberId: "member-1",
            ownerDisplayName: "Alice",
            atCount: 2,
            forkedAt: "2026-07-19T00:00:00.000Z",
          },
        }),
        target: TARGET,
        viewerOwnsSession: true,
      })
    ).toBe(true);
  });

  it("rejects imports, mismatched forks, non-owners, and a mismatched target", () => {
    expect(
      canRunOwnedCloudComments({
        session: session({
          importedFrom: {
            orgId: "org-1",
            sourceSessionId: "session-1",
            ownerMemberId: "member-2",
            epoch: 1,
            seq: 1,
            count: 2,
          },
        }),
        target: TARGET,
        viewerOwnsSession: true,
      })
    ).toBe(false);
    expect(
      canRunOwnedCloudComments({
        session: session({
          session_id: "fork-session-1",
          forkedFrom: {
            orgId: "other-org",
            sourceSessionId: "session-1",
            ownerMemberId: "member-1",
            ownerDisplayName: "Alice",
            atCount: 2,
            forkedAt: "2026-07-19T00:00:00.000Z",
          },
        }),
        target: TARGET,
        viewerOwnsSession: true,
      })
    ).toBe(false);
    expect(
      canRunOwnedCloudComments({
        session: session(),
        target: TARGET,
        viewerOwnsSession: false,
      })
    ).toBe(false);
    expect(
      canRunOwnedCloudComments({
        session: session(),
        target: { ...TARGET, sessionId: "other-session" },
        viewerOwnsSession: true,
      })
    ).toBe(false);
  });
});

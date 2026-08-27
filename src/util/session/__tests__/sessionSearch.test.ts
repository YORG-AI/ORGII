import { describe, expect, it } from "vitest";

import type { Session } from "@src/store/session";

import { getSessionSearchText } from "../sessionSearch";

function session(overrides: Partial<Session> = {}): Session {
  return {
    session_id: "codexapp-rollout-2026-07-29",
    status: "completed",
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
    name: "Rollout notes",
    ...overrides,
  };
}

describe("getSessionSearchText", () => {
  it("includes the canonical session id", () => {
    expect(getSessionSearchText(session(), "Session")).toContain(
      "codexapp-rollout-2026-07-29"
    );
  });

  it("includes the source id of an imported cloud replay", () => {
    expect(
      getSessionSearchText(
        session({
          session_id: "imported-session-local-copy",
          importedFrom: {
            orgId: "org-1",
            sourceSessionId: "codexapp-rollout-2026-07-29",
            ownerMemberId: "member-1",
            epoch: 1,
            seq: 1,
            count: 1,
          },
        }),
        "Session"
      )
    ).toContain("codexapp-rollout-2026-07-29");
  });
});

import { describe, expect, it } from "vitest";

import type { Session } from "@src/store/session";

import { expandVisibleGroupsForSessions } from "../loadedSessionVisibility";

function makeSession(
  sessionId: string,
  overrides: Partial<Session> = {}
): Session {
  return {
    session_id: sessionId,
    status: "completed",
    created_at: "2026-07-30T00:00:00Z",
    updated_at: "2026-07-30T00:00:00Z",
    ...overrides,
  };
}

describe("expandVisibleGroupsForSessions", () => {
  it("reveals every agent group returned by one shared Standalone page", () => {
    const next = expandVisibleGroupsForSessions(
      new Map(),
      [
        makeSession("sdeagent-next"),
        makeSession("wingman-next"),
        makeSession("custom-next"),
      ],
      "byAgent"
    );

    expect(next.get("agent:sde")).toBe(11);
    expect(next.get("agent:wingman")).toBe(11);
    expect(next.get("agent:custom")).toBe(11);
  });

  it("reveals pinned and Agent Org rows in their actual destination groups", () => {
    const next = expandVisibleGroupsForSessions(
      new Map([
        ["pinned", 10],
        ["agent-org:org-2", 10],
      ]),
      [
        makeSession("sdeagent-pinned", { pinned: true }),
        makeSession("sdeagent-org-root", { agentOrgId: "org-2" }),
      ],
      "byAgent"
    );

    expect(next.get("pinned")).toBe(11);
    expect(next.get("agent-org:org-2")).toBe(11);
  });

  it("uses the active time and workspace grouping modes", () => {
    const updatedAt = new Date().toISOString();
    const session = makeSession("sdeagent-next", {
      updated_at: updatedAt,
      repoPath: "/workspace/orgii/",
    });

    const byTime = expandVisibleGroupsForSessions(
      new Map(),
      [session],
      "byTime"
    );
    const byWorkspace = expandVisibleGroupsForSessions(
      new Map(),
      [session],
      "byWorkspace"
    );

    expect(byTime.get("time:today")).toBe(11);
    expect(byWorkspace.get("workspace:/workspace/orgii")).toBe(11);
  });
});

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";

import {
  needsAgentOrgMemberSessionIdentity,
  resolveAgentOrgMemberSessionIdentity,
} from "./useAgentOrgMemberSessionJump";

function member(
  overrides: Partial<AgentOrgRunMemberView> = {}
): AgentOrgRunMemberView {
  return {
    memberId: "member-view",
    name: "Member",
    role: "Build",
    agentId: "agent-member",
    isCoordinator: false,
    writerCapable: false,
    sessionRuntime: {
      sessionId: "session-member",
      status: "running",
      updatedAt: "2026-08-26T00:00:00Z",
    },
    unreadInboxCount: 0,
    inboxActivityCount: 0,
    activeTaskCount: 0,
    pendingTaskCount: 0,
    inProgressTaskCount: 0,
    completedTaskCount: 0,
    queuedUserDirectedCount: 0,
    activity: null,
    intervention: null,
    ...overrides,
  };
}

describe("Agent Org Member Session identity", () => {
  it("uses the canonical Root as the parent when an older Run View row omits it", () => {
    expect(
      resolveAgentOrgMemberSessionIdentity("session-root", member())
    ).toEqual({
      orgMemberId: "member-view",
      parentSessionId: "session-root",
    });
  });

  it("prefers runtime-owned identity when it is present", () => {
    expect(
      resolveAgentOrgMemberSessionIdentity(
        "session-root",
        member({
          sessionRuntime: {
            sessionId: "session-member",
            parentSessionId: "runtime-root",
            memberId: "runtime-member",
            status: "running",
            updatedAt: "2026-08-26T00:00:00Z",
          },
        })
      )
    ).toEqual({
      orgMemberId: "runtime-member",
      parentSessionId: "runtime-root",
    });
  });

  it("does not make the canonical Root its own parent", () => {
    expect(
      resolveAgentOrgMemberSessionIdentity(
        "session-root",
        member({
          memberId: "coordinator",
          isCoordinator: true,
          sessionRuntime: {
            sessionId: "session-root",
            status: "running",
            updatedAt: "2026-08-26T00:00:00Z",
          },
        })
      )
    ).toEqual({
      orgMemberId: "coordinator",
      parentSessionId: undefined,
    });
  });

  it("detects a cached Session that still needs Agent Org identity", () => {
    expect(
      needsAgentOrgMemberSessionIdentity(
        { orgMemberId: undefined, parentSessionId: undefined },
        { orgMemberId: "member-view", parentSessionId: "session-root" }
      )
    ).toBe(true);
    expect(
      needsAgentOrgMemberSessionIdentity(
        {
          orgMemberId: "member-view",
          parentSessionId: "session-root",
        },
        { orgMemberId: "member-view", parentSessionId: "session-root" }
      )
    ).toBe(false);
  });
});

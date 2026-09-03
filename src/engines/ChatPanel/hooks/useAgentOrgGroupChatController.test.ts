import { describe, expect, it } from "vitest";

import {
  isDirectAgentOrgMemberView,
  shouldBlockPausedAgentOrgGroupChatSubmit,
  shouldRouteAgentOrgGroupChatSubmit,
  shouldUseAgentOrgMemberGroupTransport,
} from "./useAgentOrgGroupChatController";

describe("Agent Org group chat routing boundary", () => {
  it("treats a non-coordinator Member as a direct-work view", () => {
    expect(isDirectAgentOrgMemberView({ isCoordinator: false } as never)).toBe(
      true
    );
    expect(isDirectAgentOrgMemberView({ isCoordinator: true } as never)).toBe(
      false
    );
    expect(isDirectAgentOrgMemberView(null)).toBe(false);
  });

  it("does not let a stale root Group Chat selection capture Member direct input", () => {
    expect(shouldRouteAgentOrgGroupChatSubmit(true, true, "fix the file")).toBe(
      false
    );
    expect(
      shouldRouteAgentOrgGroupChatSubmit(true, true, "@planner fix the file")
    ).toBe(false);
  });

  it("preserves existing root Group Chat and mention routing", () => {
    expect(shouldRouteAgentOrgGroupChatSubmit(true, false, "hello")).toBe(true);
    expect(
      shouldRouteAgentOrgGroupChatSubmit(false, false, "@planner hello")
    ).toBe(true);
    expect(shouldRouteAgentOrgGroupChatSubmit(false, false, "hello")).toBe(
      false
    );
  });

  it("delegates default and explicit Coordinator messages to the canonical Root queue", () => {
    expect(shouldUseAgentOrgMemberGroupTransport(null)).toBe(false);
    expect(shouldUseAgentOrgMemberGroupTransport("sde-planner")).toBe(true);
  });

  it("blocks paused Group Chat but lets canonical Member direct fall through", () => {
    expect(
      shouldBlockPausedAgentOrgGroupChatSubmit(
        "paused",
        true,
        false,
        "group message"
      )
    ).toBe(true);
    expect(
      shouldBlockPausedAgentOrgGroupChatSubmit(
        "paused",
        false,
        false,
        "@planner group message"
      )
    ).toBe(true);
    expect(
      shouldBlockPausedAgentOrgGroupChatSubmit(
        "paused",
        true,
        true,
        "direct side quest"
      )
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  groupChatRetryRequest,
  isDirectAgentOrgMemberView,
  isDurableGroupDeliveryOutcomeUnknown,
  isGroupRetryEnvelopeDurable,
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
    expect(shouldRouteAgentOrgGroupChatSubmit(true, true, 0)).toBe(false);
    expect(shouldRouteAgentOrgGroupChatSubmit(true, true, 1)).toBe(false);
  });

  it("routes Group view and structured Member pills without text parsing", () => {
    expect(shouldRouteAgentOrgGroupChatSubmit(true, false, 0)).toBe(true);
    expect(shouldRouteAgentOrgGroupChatSubmit(false, false, 1)).toBe(true);
    expect(shouldRouteAgentOrgGroupChatSubmit(false, false, 0)).toBe(false);
  });

  it("delegates default and explicit Coordinator messages to the canonical Root queue", () => {
    expect(shouldUseAgentOrgMemberGroupTransport([])).toBe(false);
    expect(shouldUseAgentOrgMemberGroupTransport(["sde-planner"])).toBe(true);
  });

  it("allows paused Member Group work but keeps Root submission behind Resume", () => {
    expect(shouldBlockPausedAgentOrgGroupChatSubmit("paused", [])).toBe(true);
    expect(
      shouldBlockPausedAgentOrgGroupChatSubmit("paused", ["planner"])
    ).toBe(false);
    expect(shouldBlockPausedAgentOrgGroupChatSubmit("running", [])).toBe(false);
  });

  it("replays an immutable Group envelope with the exact original Turn ids", () => {
    const envelope = {
      fingerprint: "immutable-request",
      deliveries: [
        { targetMemberId: "implementer", turnIntentId: "turn-a" },
        { targetMemberId: "reviewer", turnIntentId: "turn-b" },
      ],
      content: "Check the discount boundary",
      displayText: "@Implementer @Reviewer Check the discount boundary",
      images: ["data:image/png;base64,one"],
      targetMemberNames: ["Implementer", "Reviewer"],
    };

    const first = groupChatRetryRequest(envelope);
    first.deliveries[0].turnIntentId = "mutated-copy";
    first.images?.push("data:image/png;base64,two");

    expect(groupChatRetryRequest(envelope)).toEqual({
      deliveries: [
        { targetMemberId: "implementer", turnIntentId: "turn-a" },
        { targetMemberId: "reviewer", turnIntentId: "turn-b" },
      ],
      content: "Check the discount boundary",
      displayText: "@Implementer @Reviewer Check the discount boundary",
      images: ["data:image/png;base64,one"],
    });
  });

  it("only exposes Retry after an error that may follow a durable commit", () => {
    expect(
      isDurableGroupDeliveryOutcomeUnknown(
        new Error("group_delivery_response_loss_after_kick_fault: dropped")
      )
    ).toBe(true);
    expect(
      isDurableGroupDeliveryOutcomeUnknown(
        new Error("group_delivery_commit_before_kick_fault: pending")
      )
    ).toBe(true);
    expect(
      isDurableGroupDeliveryOutcomeUnknown(
        new Error("group_delivery_kick_failed: pending")
      )
    ).toBe(true);
    expect(
      isDurableGroupDeliveryOutcomeUnknown(
        new Error("group_target_limit_exceeded: at most 10 Members")
      )
    ).toBe(false);
  });

  it("clears an outcome-unknown retry only after every original Turn is durable", () => {
    const envelope = {
      fingerprint: "atomic-request",
      deliveries: [
        { targetMemberId: "implementer", turnIntentId: "turn-a" },
        { targetMemberId: "reviewer", turnIntentId: "turn-b" },
      ],
      content: "Review together",
      displayText: "@Implementer @Reviewer Review together",
      targetMemberNames: ["Implementer", "Reviewer"],
    };

    expect(isGroupRetryEnvelopeDurable(envelope, new Set(["turn-a"]))).toBe(
      false
    );
    expect(
      isGroupRetryEnvelopeDurable(envelope, new Set(["turn-a", "turn-b"]))
    ).toBe(true);
  });
});

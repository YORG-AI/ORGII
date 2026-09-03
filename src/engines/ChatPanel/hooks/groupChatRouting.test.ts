import { describe, expect, it } from "vitest";

import {
  GROUP_CHAT_MIXED_TARGETS_ERROR,
  resolveGroupChatOutgoing,
} from "./groupChatRouting";

const members = [
  { memberId: "coordinator", name: "Lead", isCoordinator: true },
  { memberId: "alice", name: "Same Name", isCoordinator: false },
  { memberId: "bob", name: "Same Name", isCoordinator: false },
] as const;

function input(memberIds: string[]) {
  return {
    displayText: "@Same Name @Same Name please review",
    memberMentions: memberIds.map((memberId) => ({
      memberId,
      displayName: "Same Name",
    })),
    displayTextWithoutMemberMentions: "please review",
    agentContentWithoutMemberMentions: "please review",
  };
}

describe("resolveGroupChatOutgoing", () => {
  it("routes by canonical pill ids even when display names collide", () => {
    const outgoing = resolveGroupChatOutgoing(input(["alice", "bob"]), members);
    expect(outgoing.targetMemberIds).toEqual(["alice", "bob"]);
    expect(outgoing.agentBody).toBe("please review");
  });

  it("deduplicates repeated pills by id while preserving first order", () => {
    const outgoing = resolveGroupChatOutgoing(
      input(["bob", "alice", "bob"]),
      members
    );
    expect(outgoing.targetMemberIds).toEqual(["bob", "alice"]);
  });

  it("keeps zero targets on the typed GroupRoot path", () => {
    const outgoing = resolveGroupChatOutgoing(input([]), members);
    expect(outgoing.targetMemberIds).toEqual([]);
  });

  it("keeps a Coordinator-only pill on the typed GroupRoot path", () => {
    const outgoing = resolveGroupChatOutgoing(input(["coordinator"]), members);
    expect(outgoing.targetMemberIds).toEqual([]);
  });

  it("rejects mixed Coordinator and Member pills", () => {
    expect(() =>
      resolveGroupChatOutgoing(input(["coordinator", "alice"]), members)
    ).toThrow(GROUP_CHAT_MIXED_TARGETS_ERROR);
  });

  it("rejects a stale or forged member id", () => {
    expect(() => resolveGroupChatOutgoing(input(["removed"]), members)).toThrow(
      "Unknown Agent Team Member pill"
    );
  });
});

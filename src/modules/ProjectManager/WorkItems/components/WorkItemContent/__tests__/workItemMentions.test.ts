import { describe, expect, it } from "vitest";

import {
  decodeMentionRef,
  encodeMentionRef,
  mentionedMemberIds,
  normalizeWorkItemMentions,
} from "../workItemMentions";

describe("normalizeWorkItemMentions", () => {
  const context = {
    members: [
      { id: "alice", name: "Alice" },
      { id: "bob", name: "Bob" },
      { id: "carol", name: "Carol" },
    ],
    agents: [{ id: "builtin:sde", name: "SDE" }],
    agentOrgs: [{ id: "org-1", name: "Core Org" }],
    currentUserId: "alice",
  };

  it("keeps stable eligible refs in first-selected order", () => {
    expect(
      normalizeWorkItemMentions(
        [
          " member:bob ",
          "member:missing",
          "member:bob",
          "member:carol",
          "member:alice",
        ],
        context
      )
    ).toEqual([
      { kind: "member", id: "bob" },
      { kind: "member", id: "carol" },
    ]);
  });

  it("decodes agent, org, and all refs and drops unknown ids", () => {
    expect(
      normalizeWorkItemMentions(
        ["agent:builtin:sde", "agent:missing", "agent_org:org-1", "all", "all"],
        context
      )
    ).toEqual([
      { kind: "agent", id: "builtin:sde" },
      { kind: "agent_org", id: "org-1" },
      { kind: "all" },
    ]);
  });

  it("rejects malformed refs", () => {
    expect(
      normalizeWorkItemMentions([":", "agent:", "unknown:x", ""], context)
    ).toEqual([]);
  });

  it("round-trips refs through encode/decode", () => {
    const targets = [
      { kind: "member", id: "bob" },
      { kind: "agent", id: "builtin:sde" },
      { kind: "agent_org", id: "org-1" },
      { kind: "all" },
    ] as const;
    for (const target of targets) {
      expect(decodeMentionRef(encodeMentionRef(target))).toEqual(target);
    }
  });

  it("projects member-only ids for the legacy field", () => {
    expect(
      mentionedMemberIds([
        { kind: "agent", id: "builtin:sde" },
        { kind: "member", id: "bob" },
        { kind: "all" },
        { kind: "member", id: "carol" },
      ])
    ).toEqual(["bob", "carol"]);
  });
});

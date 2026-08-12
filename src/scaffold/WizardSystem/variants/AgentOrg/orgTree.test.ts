import { describe, expect, it } from "vitest";

import type { TeamMember } from "@src/components/TeamMemberTable";

import {
  allMemberPairKeys,
  canonicalPairKey,
  connectedCountByMemberId,
  linksToPairSet,
  pairKeyIncludesMember,
  pairKeysWithNewMember,
  pairKeysWithoutMember,
  sortedLinksFromPairSet,
} from "./orgTree";

function members(count: number): TeamMember[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `member-${index}`,
    name: `Member ${index}`,
    role: index % 2 ? "Reviewer" : "Builder",
    agentId: "builtin:sde",
  }));
}

describe("flat Team communication draft", () => {
  it("materializes every canonical pair for a new three-Member Team", () => {
    const roster = members(3);
    const pairs = allMemberPairKeys(roster);

    expect(pairs.size).toBe(3);
    expect([...connectedCountByMemberId(roster, pairs).values()]).toEqual([
      2, 2, 2,
    ]);
    expect(sortedLinksFromPairSet(pairs)).toEqual([
      { memberAId: "member-0", memberBId: "member-1" },
      { memberAId: "member-0", memberBId: "member-2" },
      { memberAId: "member-1", memberBId: "member-2" },
    ]);
  });

  it("materializes exactly 1,225 pairs for 50 Members", () => {
    const roster = members(50);
    const pairs = allMemberPairKeys(roster);

    expect(pairs.size).toBe(1_225);
    expect(connectedCountByMemberId(roster, pairs).get("member-17")).toBe(49);
  });

  it("uses one undirected key from either panel endpoint", () => {
    expect(canonicalPairKey("alice", "bob")).toBe(
      canonicalPairKey("bob", "alice")
    );
  });

  it("removes one link and updates both endpoint counts only", () => {
    const roster = members(3);
    const pairs = allMemberPairKeys(roster);
    pairs.delete(canonicalPairKey("member-0", "member-1"));

    expect([...connectedCountByMemberId(roster, pairs).values()]).toEqual([
      1, 1, 2,
    ]);
  });

  it("connects a newly added Member to every existing Member", () => {
    const existing = members(3);
    const pairs = allMemberPairKeys(existing);
    const next = pairKeysWithNewMember(existing, pairs, "member-3");
    const roster = [...existing, members(4)[3]];

    expect(next.size).toBe(6);
    expect([...connectedCountByMemberId(roster, next).values()]).toEqual([
      3, 3, 3, 3,
    ]);
  });

  it("removes a deleted Member's links without changing surviving pair identity", () => {
    const roster = members(3);
    const original = allMemberPairKeys(roster);
    const survivingKey = canonicalPairKey("member-0", "member-2");
    const next = pairKeysWithoutMember(original, "member-1");

    expect(next).toEqual(new Set([survivingKey]));
    expect(next.has(canonicalPairKey("member-2", "member-0"))).toBe(true);
  });

  it("keeps communication pair identity stable when a Member is renamed", () => {
    const roster = members(2);
    const pairs = allMemberPairKeys(roster);
    const renamed = roster.map((member) =>
      member.id === "member-0" ? { ...member, name: "Renamed Alice" } : member
    );

    expect(allMemberPairKeys(renamed)).toEqual(pairs);
  });

  it("round-trips IDs containing separators without key collisions", () => {
    const pairs = linksToPairSet([
      { memberAId: "a\u0000b", memberBId: "c" },
      { memberAId: "a", memberBId: "b\u0000c" },
    ]);

    expect(pairs.size).toBe(2);
    expect(sortedLinksFromPairSet(pairs)).toHaveLength(2);
    expect(
      [...pairs].every((key) => pairKeyIncludesMember(key, "missing"))
    ).toBe(false);
  });
});

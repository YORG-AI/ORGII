import type { TeamMember } from "@src/modules/MainApp/AgentOrgs/components/TeamMemberTable";
import type {
  FlatOrgMember,
  MemberCommunicationLink,
} from "@src/modules/MainApp/AgentOrgs/types";

export function findDuplicateMemberNameIds(
  members: { id: string; name: string }[]
): Set<string> {
  const buckets = new Map<string, string[]>();
  for (const member of members) {
    const key = member.name.trim().toLowerCase();
    if (!key) continue;
    buckets.set(key, [...(buckets.get(key) ?? []), member.id]);
  }
  return new Set(
    [...buckets.values()].filter((ids) => ids.length > 1).flatMap((ids) => ids)
  );
}

export function toTeamMembers(members: FlatOrgMember[]): TeamMember[] {
  return members.map((member) => ({
    id: member.memberId,
    name: member.name,
    role: member.role,
    agentId: member.agentId,
    runtimeConfig: member.runtimeConfig,
  }));
}

export function toFlatOrgMembers(members: TeamMember[]): FlatOrgMember[] {
  return members.map((member) => ({
    memberId: member.id,
    name: member.name,
    role: member.role,
    agentId: member.agentId,
    runtimeConfig: member.runtimeConfig,
  }));
}

export function canonicalPairKey(memberAId: string, memberBId: string): string {
  return JSON.stringify(
    memberAId < memberBId ? [memberAId, memberBId] : [memberBId, memberAId]
  );
}

export function pairKeyToLink(key: string): MemberCommunicationLink {
  const [memberAId, memberBId] = JSON.parse(key) as [string, string];
  return { memberAId, memberBId };
}

export function pairKeyIncludesMember(key: string, memberId: string): boolean {
  const { memberAId, memberBId } = pairKeyToLink(key);
  return memberAId === memberId || memberBId === memberId;
}

export function linksToPairSet(links: MemberCommunicationLink[]): Set<string> {
  return new Set(
    links.map((link) => canonicalPairKey(link.memberAId, link.memberBId))
  );
}

export function allMemberPairKeys(members: readonly TeamMember[]): Set<string> {
  const pairs = new Set<string>();
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) {
      pairs.add(canonicalPairKey(members[left].id, members[right].id));
    }
  }
  return pairs;
}

export function pairKeysWithNewMember(
  members: readonly TeamMember[],
  pairs: ReadonlySet<string>,
  newMemberId: string
): Set<string> {
  const next = new Set(pairs);
  for (const member of members) {
    next.add(canonicalPairKey(member.id, newMemberId));
  }
  return next;
}

export function pairKeysWithoutMember(
  pairs: ReadonlySet<string>,
  memberId: string
): Set<string> {
  return new Set(
    [...pairs].filter((key) => !pairKeyIncludesMember(key, memberId))
  );
}

export function connectedCountByMemberId(
  members: readonly TeamMember[],
  pairs: ReadonlySet<string>
): Map<string, number> {
  const counts = new Map(members.map((member) => [member.id, 0]));
  for (const key of pairs) {
    const { memberAId, memberBId } = pairKeyToLink(key);
    if (counts.has(memberAId))
      counts.set(memberAId, (counts.get(memberAId) ?? 0) + 1);
    if (counts.has(memberBId))
      counts.set(memberBId, (counts.get(memberBId) ?? 0) + 1);
  }
  return counts;
}

export function sortedLinksFromPairSet(
  pairs: ReadonlySet<string>
): MemberCommunicationLink[] {
  return [...pairs].sort().map(pairKeyToLink);
}

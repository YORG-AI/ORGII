/**
 * Pure structured Member-pill routing for Agent Team Group submissions.
 * Display names are presentation only; `memberId` from `member://...` is the
 * sole routing authority.
 */

export interface GroupChatRouteMember {
  memberId: string;
  name: string;
  isCoordinator: boolean;
}

export interface GroupChatOutgoing {
  targetMemberIds: string[];
  displayText: string;
  agentBody: string;
}

export interface StructuredGroupChatInput {
  displayText: string;
  memberMentions: ReadonlyArray<{
    memberId: string;
    displayName: string;
  }>;
  displayTextWithoutMemberMentions: string;
  agentContentWithoutMemberMentions: string;
}

export function resolveGroupChatOutgoing(
  input: StructuredGroupChatInput,
  members: ReadonlyArray<GroupChatRouteMember>
): GroupChatOutgoing {
  const canonicalMembers = new Map(
    members.map((member) => [member.memberId, member] as const)
  );
  const seen = new Set<string>();
  const selected: GroupChatRouteMember[] = [];
  for (const mention of input.memberMentions) {
    if (seen.has(mention.memberId)) continue;
    const member = canonicalMembers.get(mention.memberId);
    if (!member) {
      throw new Error(`Unknown Agent Team Member pill: ${mention.memberId}`);
    }
    seen.add(mention.memberId);
    selected.push(member);
  }

  const selectedCoordinator = selected.some((member) => member.isCoordinator);
  const selectedMembers = selected.filter((member) => !member.isCoordinator);
  if (selectedCoordinator && selectedMembers.length > 0) {
    throw new Error("Coordinator and Member messages must be sent separately");
  }

  return {
    targetMemberIds: selectedMembers.map((member) => member.memberId),
    displayText: input.displayText.trim(),
    agentBody: input.agentContentWithoutMemberMentions.trim(),
  };
}

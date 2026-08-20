/**
 * groupChatRouting — pure @-mention routing + display/agent body split for
 * Agent Team group chat submissions.
 *
 * Extracted from useAgentOrgGroupChatController so the projection-sensitive
 * logic is unit-testable: the composer hands the override BOTH message
 * copies (`displayText` with pill serialization for the transcript,
 * `agentContent` with the projected agent payload). Routing and the visible
 * row must come from the display copy; the member-inbox body must carry the
 * agent copy.
 */

export interface GroupChatRouteMember {
  memberId: string;
  name: string;
  isCoordinator: boolean;
}

export interface GroupChatRoute {
  targetMemberId: string | null;
  body: string;
  displayText: string;
}

export interface GroupChatOutgoing extends GroupChatRoute {
  /** Body for the member inbox / agent payload (projected copy). */
  agentBody: string;
}

function normalizeMentionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "");
}

export function parseGroupChatRoute(
  rawText: string,
  members: ReadonlyArray<GroupChatRouteMember>
): GroupChatRoute {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("@")) {
    return { targetMemberId: null, body: trimmed, displayText: trimmed };
  }

  const mentionText = trimmed.slice(1).trimStart();
  const mentionLower = mentionText.toLowerCase();
  const routeCandidates = members
    .flatMap((member) => {
      const labels = [member.name, member.memberId];
      if (member.isCoordinator) {
        labels.push("Coordinator");
      }
      return labels.map((label) => ({ label: label.trim(), member }));
    })
    .filter((candidate) => candidate.label.length > 0)
    .sort((left, right) => right.label.length - left.label.length);

  for (const candidate of routeCandidates) {
    const labelLower = candidate.label.toLowerCase();
    if (
      mentionLower === labelLower ||
      mentionLower.startsWith(`${labelLower} `) ||
      mentionLower.startsWith(`${labelLower}\n`)
    ) {
      return {
        targetMemberId: candidate.member.isCoordinator
          ? null
          : candidate.member.memberId,
        body: mentionText.slice(candidate.label.length).trim(),
        displayText: trimmed,
      };
    }
  }

  const tokenMatch = mentionText.match(/^(\S+)\s*(.*)$/s);
  const token = normalizeMentionToken(tokenMatch?.[1] ?? "");
  const member = members.find((candidate) => {
    const candidateNames = [candidate.memberId, candidate.name].map(
      normalizeMentionToken
    );
    return candidateNames.includes(token);
  });
  if (!member) {
    throw new Error(`Unknown Agent Team mention: @${tokenMatch?.[1] ?? ""}`);
  }
  return {
    targetMemberId: member.isCoordinator ? null : member.memberId,
    body: tokenMatch?.[2].trim() ?? "",
    displayText: trimmed,
  };
}

/**
 * Resolve a group chat submission from both projection fields.
 *
 * Routing (`@member`) and `displayText` always come from the display copy —
 * that is what the user typed and what the transcript renders. The member
 * inbox body comes from the agent copy when the composer produced one:
 * when the agent projection still carries the same mention header (skill
 * expansion / base64 strip preserve it) the header is stripped via the same
 * parse; when an interceptor rewrote the whole message (e.g. the Canvas
 * contract) the full agent content becomes the body.
 *
 * Throws for an unknown display-side mention (same contract as
 * parseGroupChatRoute).
 */
export function resolveGroupChatOutgoing(
  input: { displayText: string; agentContent?: string },
  members: ReadonlyArray<GroupChatRouteMember>
): GroupChatOutgoing {
  const route = parseGroupChatRoute(input.displayText, members);

  if (input.agentContent === undefined) {
    return { ...route, agentBody: route.body };
  }

  try {
    const agentRoute = parseGroupChatRoute(input.agentContent, members);
    if (agentRoute.targetMemberId === route.targetMemberId) {
      return { ...route, agentBody: agentRoute.body };
    }
  } catch {
    // The agent projection no longer parses as a routed message — fall
    // through and send it whole.
  }
  return { ...route, agentBody: input.agentContent.trim() };
}

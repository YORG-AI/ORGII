/**
 * Explicit @-mentions for Team chat.
 *
 * The composer's @ menu inserts a member pill that serializes to `@<name>`
 * (see `serializePillNode`), so the submitted body carries names, not ids.
 * Mentions are resolved back to account ids against the org roster at
 * submit time and ride the comment wire as `mentionedUserIds` — the only
 * thing that produces a team-inbox entry (Team chat never mentions anyone
 * implicitly).
 */
import type { CustomMentionOption } from "@src/engines/ChatPanel/hooks/useInputArea/types";

export interface TeamChatMentionMember {
  userId: string;
  displayName?: string;
  role?: string;
}

function mentionLabel(member: TeamChatMentionMember): string {
  return member.displayName?.trim() || member.userId;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "");
}

function isBoundary(char: string | undefined): boolean {
  return char === undefined || !/[\p{L}\p{N}_]/u.test(char);
}

export function buildTeamChatMentionOptions(
  members: readonly TeamChatMentionMember[],
  viewerUserId: string | null,
  groupLabel: string
): CustomMentionOption[] {
  return members
    .filter((member) => member.userId !== viewerUserId)
    .map((member) => ({
      id: member.userId,
      label: mentionLabel(member),
      description: member.role,
      groupLabel,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Account ids mentioned in a Team chat body, in first-appearance order.
 * A pill-inserted `@Display Name` matches its full label (longest label
 * first, so "Ann Lee" wins over "Ann"); a hand-typed `@ann` matches a
 * single token against the normalized display name or the user id.
 */
export function resolveTeamChatMentions(
  body: string,
  members: readonly TeamChatMentionMember[]
): string[] {
  if (!body.includes("@") || members.length === 0) return [];
  const labelled = members
    .map((member) => ({ member, label: mentionLabel(member) }))
    .filter((entry) => entry.label.length > 0)
    .sort((left, right) => right.label.length - left.label.length);
  const lowerBody = body.toLowerCase();
  const found: string[] = [];
  const push = (userId: string) => {
    if (!found.includes(userId)) found.push(userId);
  };
  let index = body.indexOf("@");
  while (index !== -1) {
    const start = index + 1;
    let consumed = 0;
    if (isBoundary(body[index - 1])) {
      for (const entry of labelled) {
        const lowerLabel = entry.label.toLowerCase();
        if (
          lowerBody.startsWith(lowerLabel, start) &&
          isBoundary(body[start + lowerLabel.length])
        ) {
          push(entry.member.userId);
          consumed = lowerLabel.length;
          break;
        }
      }
      if (consumed === 0) {
        const token = body.slice(start).match(/^\S+/)?.[0] ?? "";
        const normalized = normalizeToken(token);
        if (normalized) {
          const member = members.find(
            (candidate) =>
              normalizeToken(mentionLabel(candidate)) === normalized ||
              normalizeToken(candidate.userId) === normalized
          );
          if (member) {
            push(member.userId);
            consumed = token.length;
          }
        }
      }
    }
    index = body.indexOf("@", start + Math.max(consumed, 0));
  }
  return found;
}

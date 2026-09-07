/**
 * Explicit @-mentions for Team chat.
 *
 * The composer's @ menu inserts a member pill that serializes visibly to
 * `@<name>` while its submit-time snapshot retains `member://<user-id>`.
 * Typed pills therefore stay identity-stable; hand-typed mentions alone use
 * the org roster fallback. Resolved ids ride the comment wire as
 * `mentionedUserIds` — Team chat never notifies anyone implicitly.
 */
import type { ComposerSnapshot } from "@src/components/ComposerInput";
import type { CustomMentionOption } from "@src/engines/ChatPanel/hooks/useInputArea/types";
import {
  type MessageAudienceTarget,
  resolveMessageAudience,
} from "@src/features/TeamCollaboration/messageAudienceRouting";

import {
  CLOUD_COMMENT_MAX_BODY_LENGTH,
  CLOUD_COMMENT_MAX_MENTIONED_USER_IDS,
} from "../org2CloudCommentsClient";

export interface TeamChatMentionMember {
  userId: string;
  displayName?: string;
  role?: string;
}

export function isTeamChatBodyWithinLimit(body: string): boolean {
  // PostgreSQL char_length counts Unicode code points, not UTF-16 units.
  return Array.from(body).length <= CLOUD_COMMENT_MAX_BODY_LENGTH;
}

export function isTeamChatMentionAudienceWithinLimit(
  mentionedUserIds: readonly string[]
): boolean {
  return mentionedUserIds.length <= CLOUD_COMMENT_MAX_MENTIONED_USER_IDS;
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
  const memberOptions = members
    .filter((member) => member.userId !== viewerUserId)
    .map((member) => ({
      id: member.userId,
      label: mentionLabel(member),
      description: member.role,
      groupLabel,
      audienceTarget: { kind: "member" as const, id: member.userId },
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  if (memberOptions.length === 0) return [];
  return memberOptions.length <= CLOUD_COMMENT_MAX_MENTIONED_USER_IDS
    ? [
        {
          id: "team-chat:all",
          label: "all",
          groupLabel,
          audienceTarget: { kind: "all" },
        },
        ...memberOptions,
      ]
    : memberOptions;
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

function containsAllMention(body: string): boolean {
  return /(^|[^\p{L}\p{N}_])@all(?=$|[^\p{L}\p{N}_])/iu.test(body);
}

function targetsFromText(
  body: string,
  members: readonly TeamChatMentionMember[]
): MessageAudienceTarget[] {
  const targets: MessageAudienceTarget[] = [];
  if (containsAllMention(body)) targets.push({ kind: "all" });
  // `@all` is reserved for channel audience. Mask it before the display-name
  // fallback so a member whose display name happens to be "all" cannot steal
  // a hand-typed channel mention.
  const memberBody = body.replace(
    /(^|[^\p{L}\p{N}_])@all(?=$|[^\p{L}\p{N}_])/giu,
    "$1"
  );
  targets.push(
    ...resolveTeamChatMentions(memberBody, members).map((id) => ({
      kind: "member" as const,
      id,
    }))
  );
  return targets;
}

function targetFromPill(
  part: Extract<ComposerSnapshot["parts"][number], { kind: "pill" }>
): MessageAudienceTarget | null {
  if (part.attrs.iconType !== "member") return null;
  if (part.attrs.filePath === "audience://all") return { kind: "all" };
  const match = part.attrs.filePath.match(/^member:\/\/(.+)$/);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]).trim();
    if (!id) return null;
    return { kind: "member", id };
  } catch {
    return null;
  }
}

/**
 * Agent and Agent Org pills can remain in the editor when its mode changes.
 * They are a different address space from Cloud members, so Team Chat must
 * reject the snapshot explicitly instead of displaying a pill that silently
 * resolves to no human recipient.
 */
export function hasUnsupportedTeamChatAudiencePill(
  snapshot?: ComposerSnapshot
): boolean {
  return Boolean(
    snapshot?.parts.some(
      (part) =>
        part.kind === "pill" &&
        /^(agent|agent_org):\/\//.test(part.attrs.filePath)
    )
  );
}

function uniqueTargets(
  targets: readonly MessageAudienceTarget[]
): MessageAudienceTarget[] {
  const seen = new Set<string>();
  const result: MessageAudienceTarget[] = [];
  for (const target of targets) {
    const key = target.kind === "all" ? "all" : `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

/**
 * Resolve the audience from the exact submit-time editor snapshot. Member
 * pills carry account ids; only ordinary text fragments use the display-name
 * fallback. This prevents a roster rename during an async submit from
 * retargeting a message.
 */
export function resolveTeamChatAudienceTargets(
  body: string,
  members: readonly TeamChatMentionMember[],
  snapshot?: ComposerSnapshot
): MessageAudienceTarget[] {
  if (!snapshot) return uniqueTargets(targetsFromText(body, members));
  const targets: MessageAudienceTarget[] = [];
  let snapshotHasContent = false;
  for (const part of snapshot.parts) {
    if (part.kind === "text") {
      snapshotHasContent ||= part.text.length > 0;
      targets.push(...targetsFromText(part.text, members));
    } else if (part.kind === "pill") {
      snapshotHasContent = true;
      const target = targetFromPill(part);
      if (target) targets.push(target);
    }
  }
  if (!snapshotHasContent) {
    return uniqueTargets(targetsFromText(body, members));
  }
  return uniqueTargets(targets);
}

/** IDs that should receive human notifications for the current Team chat body. */
export function resolveTeamChatMentionedUserIds(
  body: string,
  members: readonly TeamChatMentionMember[],
  snapshot?: ComposerSnapshot,
  viewerUserId?: string | null
): string[] {
  const targets = resolveTeamChatAudienceTargets(body, members, snapshot);
  const audience = resolveMessageAudience("team_chat", targets);
  if (audience.human.scope === "channel") {
    return [
      ...new Set(
        members
          .map((member) => member.userId)
          .filter((id) => id !== viewerUserId)
      ),
    ];
  }
  if (audience.human.scope !== "members") return [];
  const rosterMemberIds = new Set(members.map((member) => member.userId));
  return audience.human.memberIds.filter(
    (id) => id !== viewerUserId && rosterMemberIds.has(id)
  );
}

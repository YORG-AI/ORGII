import type { WorkItemMentionTarget } from "@src/api/http/project";
import type { Person } from "@src/types/core/shared";

/**
 * Canonical mention model for Work Item Discussion comments.
 *
 * Ids are the durable identity boundary; labels and free-form @text are
 * presentation only. The picker state is a flat list of encoded refs
 * ("member:x" / "agent:y" / "agent_org:z" / "all") so a single multi-select
 * can carry every target kind; refs decode to typed mentions at submit time.
 */
export const ALL_MENTION_REF = "all";

export interface MentionCandidate {
  id: string;
  name: string;
}

export function encodeMentionRef(target: WorkItemMentionTarget): string {
  return target.kind === "all"
    ? ALL_MENTION_REF
    : `${target.kind}:${target.id}`;
}

export function decodeMentionRef(ref: string): WorkItemMentionTarget | null {
  if (ref === ALL_MENTION_REF) return { kind: "all" };
  const separator = ref.indexOf(":");
  if (separator <= 0) return null;
  const kind = ref.slice(0, separator);
  const id = ref.slice(separator + 1).trim();
  if (!id) return null;
  if (kind === "member" || kind === "agent" || kind === "agent_org") {
    return { kind, id };
  }
  return null;
}

export interface MentionNormalizationContext {
  members: readonly Person[];
  agents?: readonly MentionCandidate[];
  agentOrgs?: readonly MentionCandidate[];
  currentUserId: string;
}

/**
 * Decode and validate encoded refs: unknown ids, duplicates, and the current
 * user are rejected before the comment reaches persistence.
 */
export function normalizeWorkItemMentions(
  refs: readonly string[],
  context: MentionNormalizationContext
): WorkItemMentionTarget[] {
  const eligibleMembers = new Set(
    context.members
      .map((member) => member.id.trim())
      .filter((id) => id && id !== context.currentUserId)
  );
  const eligibleAgents = new Set(
    (context.agents ?? []).map((agent) => agent.id.trim()).filter(Boolean)
  );
  const eligibleOrgs = new Set(
    (context.agentOrgs ?? []).map((org) => org.id.trim()).filter(Boolean)
  );

  const normalized: WorkItemMentionTarget[] = [];
  const seen = new Set<string>();
  for (const candidate of refs) {
    const target = decodeMentionRef(candidate.trim());
    if (!target) continue;
    const ref = encodeMentionRef(target);
    if (seen.has(ref)) continue;
    if (target.kind === "member" && !eligibleMembers.has(target.id)) continue;
    if (target.kind === "agent" && !eligibleAgents.has(target.id)) continue;
    if (target.kind === "agent_org" && !eligibleOrgs.has(target.id)) continue;
    seen.add(ref);
    normalized.push(target);
  }
  return normalized;
}

/** Member-only ids for the legacy notification field. */
export function mentionedMemberIds(
  mentions: readonly WorkItemMentionTarget[]
): string[] {
  return mentions
    .filter(
      (target): target is { kind: "member"; id: string } =>
        target.kind === "member"
    )
    .map((target) => target.id);
}

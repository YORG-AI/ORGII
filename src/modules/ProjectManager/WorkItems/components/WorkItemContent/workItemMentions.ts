import type { Person } from "@src/types/core/shared";

/**
 * Canonicalize a comment's explicit notification recipients.
 *
 * Member ids are the durable identity boundary; labels and free-form @text
 * are presentation only. Unknown, duplicate, and self ids are rejected before
 * the comment reaches persistence.
 */
export function normalizeWorkItemMentionIds(
  ids: readonly string[],
  members: readonly Person[],
  currentUserId: string
): string[] {
  const eligibleIds = new Set(
    members
      .map((member) => member.id.trim())
      .filter((id) => id && id !== currentUserId)
  );
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ids) {
    const id = candidate.trim();
    if (!eligibleIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

import type { MemberEntry } from "@src/api/http/project";
import type { Person } from "@src/types/core/shared";

export interface PropertyMemberSnapshot {
  scopeKey: string;
  members: Person[];
}

export function activeMemberEntriesToPeople(entries: MemberEntry[]): Person[] {
  return entries
    .filter((entry) => entry.active)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      email: entry.email,
      avatar: entry.avatar,
    }));
}

/**
 * Project-backed actor properties must use the member catalog read for that
 * exact project. A parent surface can temporarily retain members from a
 * previous project while its next load is in flight, so it is only a fallback
 * for projectless org-scoped Work Items.
 */
export function resolvePropertyMembers(
  projectSlug: string | null | undefined,
  scopeKey: string,
  snapshot: PropertyMemberSnapshot | null,
  fallbackMembers: Person[]
): Person[] {
  if (!projectSlug) return fallbackMembers;
  return snapshot?.scopeKey === scopeKey ? snapshot.members : [];
}

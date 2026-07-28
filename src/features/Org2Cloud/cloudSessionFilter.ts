import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type { CloudOrgMember } from "./org2CloudClient";

/** One Team-sessions filter; discriminated so user ids can never collide. */
export type CloudSessionFilter =
  | { kind: "all" }
  | { kind: "directlySharedWithMe" }
  | { kind: "member"; ownerUserId: string };

export const ALL_CLOUD_SESSIONS_FILTER: CloudSessionFilter = { kind: "all" };

export interface CloudSessionMemberFilterOption {
  userId: string;
  displayName: string;
}

/**
 * Member filters come from the active org roster, not from whichever owners
 * happen to have a currently listed Session. Rows remain a resilience
 * fallback while the roster is loading or when a legacy backend omits an
 * otherwise visible owner. A known removed member is never resurrected by an
 * old retained row.
 */
export function buildCloudSessionMemberFilterOptions(
  rows: readonly RemoteTeammateSessionMetadata[],
  members:
    | readonly Pick<CloudOrgMember, "userId" | "displayName" | "status">[]
    | null
): CloudSessionMemberFilterOption[] {
  const byUserId = new Map<string, string>();
  const rosterStatus = new Map<string, string>();
  for (const member of members ?? []) {
    rosterStatus.set(member.userId, member.status);
    if (member.status !== "active") continue;
    byUserId.set(member.userId, member.displayName ?? member.userId);
  }
  for (const row of rows) {
    const knownStatus = rosterStatus.get(row.ownerUserId);
    if (row.deletedAt || (knownStatus && knownStatus !== "active")) {
      continue;
    }
    if (!byUserId.has(row.ownerUserId)) {
      byUserId.set(row.ownerUserId, row.ownerDisplayName);
    }
  }
  return [...byUserId].map(([userId, displayName]) => ({
    userId,
    displayName,
  }));
}

/**
 * Pure row filter used before thread grouping. Filtering first guarantees
 * local/imported duplicate suppression is derived from the rows the user can
 * actually see, so switching filters can never make a local session vanish.
 */
export function filterCloudSessionRows(
  rows: readonly RemoteTeammateSessionMetadata[],
  filter: CloudSessionFilter
): RemoteTeammateSessionMetadata[] {
  switch (filter.kind) {
    case "all":
      return [...rows];
    case "directlySharedWithMe":
      return rows.filter((row) => row.directlySharedWithMe === true);
    case "member":
      return rows.filter((row) => row.ownerUserId === filter.ownerUserId);
  }
}

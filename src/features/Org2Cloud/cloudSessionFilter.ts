import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

/** One Team-sessions filter; discriminated so user ids can never collide. */
export type CloudSessionFilter =
  | { kind: "all" }
  | { kind: "directlySharedWithMe" }
  | { kind: "member"; ownerUserId: string };

export const ALL_CLOUD_SESSIONS_FILTER: CloudSessionFilter = { kind: "all" };

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

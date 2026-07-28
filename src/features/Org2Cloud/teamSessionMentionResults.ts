/**
 * Team-session candidates for the `@` menu.
 *
 * Local sessions are matched by id; a teammate's session has no local id,
 * so its candidate carries the full `orgii://…` reference as its path.
 * That keeps it unique against local ids in the same result list (the menu
 * keys rows by path) and, more importantly, keeps it out of the pill
 * machinery that special-cases a bare local session id.
 *
 * Rows are read from the already-cached listing. Nothing here fetches:
 * opening a menu must not put an RPC on the wire, so a team session the
 * viewer has never listed simply does not appear.
 */
import type { SearchResultItem } from "@src/scaffold/ContextMenu/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import { buildCloudSessionReference } from "./cloudSessionReference";

const MAX_TEAM_RESULTS = 10;
const MAX_LABEL_LENGTH = 50;

function matches(row: RemoteTeammateSessionMetadata, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    row.title.toLowerCase().includes(needle) ||
    row.ownerDisplayName.toLowerCase().includes(needle)
  );
}

export function teamSessionMentionResults(input: {
  query: string;
  rows: readonly RemoteTeammateSessionMetadata[] | undefined;
  /** The viewer, so their own rows are not offered twice. */
  selfUserId: string | null;
  localSessionIds: ReadonlySet<string>;
}): SearchResultItem[] {
  const { query, rows, selfUserId, localSessionIds } = input;
  if (!rows?.length) return [];

  const trimmed = query.trim();
  return rows
    .filter(
      (row) =>
        !row.deletedAt &&
        row.eventsEpoch !== undefined &&
        // A row the viewer owns and already has locally is offered by the
        // local list; showing it twice under a different id would let the
        // same session be inserted two incompatible ways.
        !(
          row.ownerUserId === selfUserId &&
          localSessionIds.has(row.sourceSessionId)
        ) &&
        matches(row, trimmed)
    )
    .slice(0, MAX_TEAM_RESULTS)
    .map((row) => {
      const title = row.title.replace(/^(?:⑂\s*)+/u, "").trim() || "Session";
      return {
        path: buildCloudSessionReference(row),
        name:
          title.length > MAX_LABEL_LENGTH
            ? `${title.slice(0, MAX_LABEL_LENGTH - 3)}...`
            : title,
        type: "file" as const,
        iconType: "cloudSession" as const,
        repoName: row.ownerDisplayName,
      };
    });
}

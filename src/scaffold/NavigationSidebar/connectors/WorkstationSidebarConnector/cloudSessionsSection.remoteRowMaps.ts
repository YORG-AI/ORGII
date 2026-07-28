/**
 * Lookup maps keyed by `cloudremote-` menu item id, derived from the visible
 * Team Sessions fork threads (`cloudSessionsSection.tsx`). Feeds the sidebar
 * hover card: row metadata plus who else is currently viewing it.
 */
import { useMemo } from "react";

import { buildCloudRemoteItemId } from "@src/features/Org2Cloud/cloudRemoteItemId";
import type { CloudSessionThread } from "@src/features/Org2Cloud/cloudSessionThreads";
import {
  type Org2CloudPresenceEntry,
  viewersForSession,
} from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

interface UseCloudRemoteRowMapsParams {
  visibleThreads: readonly CloudSessionThread[];
  presenceMap: Record<string, Record<string, Org2CloudPresenceEntry>>;
  selfUserId: string | null;
}

interface UseCloudRemoteRowMapsResult {
  /**
   * Teammate row metadata keyed by `cloudremote-` menu item id — feeds the
   * sidebar hover card (local "mine" rows use the session-store card instead).
   */
  cloudRemoteRowMap: ReadonlyMap<string, RemoteTeammateSessionMetadata>;
  /** Live viewers keyed by the cloud row id used to render its hover card. */
  cloudRemoteViewerMap: ReadonlyMap<string, readonly Org2CloudPresenceEntry[]>;
}

export function useCloudRemoteRowMaps({
  visibleThreads,
  presenceMap,
  selfUserId,
}: UseCloudRemoteRowMapsParams): UseCloudRemoteRowMapsResult {
  // Hover-card lookup: every visible remote thread row, keyed by the same
  // `cloudremote-` id the menu item carries.
  const cloudRemoteRowMap = useMemo(() => {
    const map = new Map<string, RemoteTeammateSessionMetadata>();
    for (const thread of visibleThreads) {
      for (const threadRow of [thread.root, ...thread.descendants]) {
        map.set(
          buildCloudRemoteItemId(threadRow.row.orgId, threadRow.row.id),
          threadRow.row
        );
      }
    }
    return map;
  }, [visibleThreads]);

  const cloudRemoteViewerMap = useMemo(() => {
    const map = new Map<string, readonly Org2CloudPresenceEntry[]>();
    for (const thread of visibleThreads) {
      for (const threadRow of [thread.root, ...thread.descendants]) {
        map.set(
          buildCloudRemoteItemId(threadRow.row.orgId, threadRow.row.id),
          viewersForSession(
            presenceMap,
            threadRow.row.orgId,
            threadRow.bareSessionId,
            selfUserId
          )
        );
      }
    }
    return map;
  }, [presenceMap, selfUserId, visibleThreads]);

  return { cloudRemoteRowMap, cloudRemoteViewerMap };
}

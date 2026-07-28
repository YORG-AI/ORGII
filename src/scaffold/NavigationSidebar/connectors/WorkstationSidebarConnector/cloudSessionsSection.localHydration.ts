/**
 * Current-device cloud session bookkeeping for `cloudSessionsSection.tsx`:
 * which rows originated on this device (`localOwnSessionIds`), which of
 * those belong to the viewer and are cached locally (`cloudLocalSessionIds`,
 * used to keep My Conversations and Team Conversations from double-listing
 * a row), and demand-hydrating the exact rows needed for the visible My
 * Conversations page.
 */
import React, { useEffect, useMemo } from "react";

import {
  collectCurrentDeviceCloudSessionIds,
  collectCurrentDeviceSessionsToHydrate,
} from "@src/features/Org2Cloud/cloudSessionThreads";
import { createLogger } from "@src/hooks/logger";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { type Session, loadSidebarSessionsByIds } from "@src/store/session";

const logger = createLogger("CloudSessionsSection");

interface UseCloudLocalSessionHydrationParams {
  orgId: string | null;
  sessions: readonly Session[];
  pushedMetadata: Readonly<Record<string, true>>;
  pushCursors: Readonly<Record<string, { orgId: string; sessionId: string }>>;
  selfUserId: string | null;
  rows: readonly RemoteTeammateSessionMetadata[];
  documentVisible: boolean;
  localSessionHydrationLimit: number;
}

interface UseCloudLocalSessionHydrationResult {
  /** Local session ids known to have been pushed/synced to this cloud org. */
  localOwnSessionIds: ReadonlySet<string>;
  /** Local-origin cloud row ids that belong in the active My section. */
  cloudLocalSessionIds: ReadonlySet<string>;
}

export function useCloudLocalSessionHydration({
  orgId,
  sessions,
  pushedMetadata,
  pushCursors,
  selfUserId,
  rows,
  documentVisible,
  localSessionHydrationLimit,
}: UseCloudLocalSessionHydrationParams): UseCloudLocalSessionHydrationResult {
  const localOwnSessionIds = useMemo(
    () =>
      orgId
        ? collectCurrentDeviceCloudSessionIds(
            orgId,
            sessions,
            pushedMetadata,
            pushCursors
          )
        : new Set<string>(),
    [orgId, pushCursors, pushedMetadata, sessions]
  );
  const loadedSessionIds = useMemo(
    () => new Set(sessions.map((session) => session.session_id)),
    [sessions]
  );
  const cloudLocalSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selfUserId) return ids;
    for (const row of rows) {
      if (
        !row.deletedAt &&
        row.ownerUserId === selfUserId &&
        localOwnSessionIds.has(row.sourceSessionId)
      ) {
        ids.add(row.sourceSessionId);
      }
    }
    return ids;
  }, [localOwnSessionIds, rows, selfUserId]);
  const localSessionIdsToHydrate = useMemo(
    () =>
      collectCurrentDeviceSessionsToHydrate(
        rows,
        selfUserId,
        localOwnSessionIds,
        loadedSessionIds,
        localSessionHydrationLimit
      ),
    [
      loadedSessionIds,
      localOwnSessionIds,
      localSessionHydrationLimit,
      rows,
      selfUserId,
    ]
  );
  const localHydrationRequestKeyRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!documentVisible) return;
    if (localSessionIdsToHydrate.length === 0) {
      localHydrationRequestKeyRef.current = null;
      return;
    }
    const requestKey = JSON.stringify(localSessionIdsToHydrate);
    if (localHydrationRequestKeyRef.current === requestKey) return;
    localHydrationRequestKeyRef.current = requestKey;
    void loadSidebarSessionsByIds(localSessionIdsToHydrate).catch(
      (error: unknown) => {
        if (localHydrationRequestKeyRef.current === requestKey) {
          localHydrationRequestKeyRef.current = null;
        }
        logger.warn("failed to hydrate local cloud sessions:", error);
      }
    );
  }, [documentVisible, localSessionIdsToHydrate]);

  return { localOwnSessionIds, cloudLocalSessionIds };
}

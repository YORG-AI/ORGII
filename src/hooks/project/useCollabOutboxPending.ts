import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { COLLAB_ENTITY_KIND, projectApi } from "@src/api/http/project";
import { COLLAB_OUTBOX_FLUSHED_EVENT } from "@src/features/TeamCollaboration/engine/projectSyncBridge";
import { createLogger } from "@src/hooks/logger";

import { useProjectDataChanged } from "./useProjectDataChanged";

const logger = createLogger("useCollabOutboxPending");

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export interface CollabOutboxPendingState {
  pendingProjectIds: ReadonlySet<string>;
  pendingWorkItemIds: ReadonlySet<string>;
}

export function useCollabOutboxPending(
  orgIds: readonly string[]
): CollabOutboxPendingState {
  const orgIdsKey = orgIds.join("\x00");
  const [pendingProjectIds, setPendingProjectIds] =
    useState<ReadonlySet<string>>(EMPTY_IDS);
  const [pendingWorkItemIds, setPendingWorkItemIds] =
    useState<ReadonlySet<string>>(EMPTY_IDS);
  const generationRef = useRef(0);

  const refresh = useCallback(() => {
    const targetOrgIds = orgIdsKey ? orgIdsKey.split("\x00") : [];
    const generation = ++generationRef.current;
    if (targetOrgIds.length === 0) {
      queueMicrotask(() => {
        if (generation !== generationRef.current) return;
        setPendingProjectIds(EMPTY_IDS);
        setPendingWorkItemIds(EMPTY_IDS);
      });
      return;
    }
    void (async () => {
      try {
        const perOrg = await Promise.all(
          targetOrgIds.map((orgId) =>
            projectApi.listCollabOutboxPendingIds(orgId)
          )
        );
        if (generation !== generationRef.current) return;
        const projects = new Set<string>();
        const workItems = new Set<string>();
        for (const entities of perOrg) {
          for (const entity of entities) {
            if (entity.kind === COLLAB_ENTITY_KIND.PROJECT) {
              projects.add(entity.entityId);
            } else {
              workItems.add(entity.entityId);
            }
          }
        }
        setPendingProjectIds((current) =>
          setsEqual(current, projects) ? current : projects
        );
        setPendingWorkItemIds((current) =>
          setsEqual(current, workItems) ? current : workItems
        );
      } catch (error) {
        logger.warn("failed to read collab outbox pending ids", error);
      }
    })();
  }, [orgIdsKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useProjectDataChanged(refresh);

  useEffect(() => {
    const onFlushed = (): void => refresh();
    window.addEventListener(COLLAB_OUTBOX_FLUSHED_EVENT, onFlushed);
    return () => {
      window.removeEventListener(COLLAB_OUTBOX_FLUSHED_EVENT, onFlushed);
    };
  }, [refresh]);

  return useMemo(
    () => ({ pendingProjectIds, pendingWorkItemIds }),
    [pendingProjectIds, pendingWorkItemIds]
  );
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

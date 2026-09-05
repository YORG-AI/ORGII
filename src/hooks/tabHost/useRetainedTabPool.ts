import { useMemo } from "react";

import { useKeepAliveWindow } from "@src/hooks/ui/useKeepAliveWindow";
import {
  RETENTION_POOLS,
  type RetentionPoolId,
  selectRetentionPoolTabIds,
} from "@src/store/workstation/tabs/tabRetention";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

/**
 * Which tabs of one retention pool may stay mounted right now.
 *
 * Applies the pool's window from `tabRetention.ts` (grace period + warm
 * cap) to the tabs currently in the pane: the active pool tab is always
 * included, recently deactivated ones stay until their grace runs out or the
 * cap evicts them, and a tab that leaves `tabs` (closed) drops at once.
 * Tabs of types outside the pool are never included — hosts render those
 * active-only and rebuild them from view state.
 *
 * A host calls this once per pool it renders and hides (rather than
 * unmounts) the returned tabs while they are not active.
 */
export function useRetainedTabPool(
  poolId: RetentionPoolId,
  tabs: readonly WorkStationTab[],
  activeTabId: string | null
): ReadonlySet<string> {
  const pool = RETENTION_POOLS[poolId];
  const presentKeys = useMemo(
    () => selectRetentionPoolTabIds(tabs, poolId),
    [poolId, tabs]
  );
  const activeKey =
    activeTabId !== null && presentKeys.includes(activeTabId)
      ? activeTabId
      : null;
  return useKeepAliveWindow(activeKey, presentKeys, {
    graceMs: pool.graceMs,
    maxWarm: pool.maxWarm,
  });
}

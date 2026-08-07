import { useEffect } from "react";

import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  externalHistoryRescanSources,
} from "@src/api/tauri/externalHistory";
import { loadSidebarSessions } from "@src/store/session";
import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
  getSourceConfig,
} from "@src/store/session/dataSourceConfigAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

/** Rescan every enabled external source, then reload the sidebar from cache. */
export async function rescanSidebarSessions(): Promise<void> {
  const store = getInstrumentedStore();
  if (!store.get(externalSessionsEnabledAtom)) {
    // External sessions are switched off entirely — nothing to rescan, and
    // the sidebar reload below would be a no-op for external categories.
    await loadSidebarSessions({ forceRefresh: true });
    return;
  }
  const config = store.get(dataSourceConfigAtom);
  const sourceIds = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.filter(
    ({ sourceId }) => getSourceConfig(config, sourceId).enabled
  ).map(({ sourceId }) => sourceId);

  await externalHistoryRescanSources(sourceIds);
  await loadSidebarSessions({ forceRefresh: true });

  const lastScannedAt = Date.now();
  store.set(dataSourceConfigAtom, (previous) => {
    const next = { ...previous };
    for (const sourceId of sourceIds) {
      next[sourceId] = {
        ...getSourceConfig(previous, sourceId),
        lastScannedAt,
      };
    }
    return next;
  });
}

import {
  SIDEBAR_SESSION_ACTIVE_REFRESH_INTERVAL_MS,
  SIDEBAR_SESSION_IDLE_REFRESH_INTERVAL_MS,
} from "../sidebarConnectorUtils";

export function useSidebarSessionRefreshEffects(): void {
  useEffect(() => {
    void loadSidebarSessions({ forceRefresh: true });
  }, []);


  useEffect(() => {
    let sidebarIntervalId: number | null = null;

    const getSidebarRefreshInterval = () =>
      document.hasFocus()
        ? SIDEBAR_SESSION_ACTIVE_REFRESH_INTERVAL_MS
        : SIDEBAR_SESSION_IDLE_REFRESH_INTERVAL_MS;

    const refreshAllSidebarSessions = () => {
      if (document.visibilityState !== "visible") return;
      void loadSidebarSessions({ forceRefresh: true });
    };

    const scheduleRefresh = () => {
      if (sidebarIntervalId !== null) {
        window.clearInterval(sidebarIntervalId);
        sidebarIntervalId = null;
      }
      if (document.visibilityState !== "visible") return;
      sidebarIntervalId = window.setInterval(
        refreshAllSidebarSessions,
        getSidebarRefreshInterval()
      );
    };

    const handleActivityStateChange = () => {
      refreshAllSidebarSessions();
      scheduleRefresh();
    };

    scheduleRefresh();
    document.addEventListener("visibilitychange", handleActivityStateChange);
    window.addEventListener("focus", handleActivityStateChange);
    window.addEventListener("blur", scheduleRefresh);
    return () => {
      if (sidebarIntervalId !== null) window.clearInterval(sidebarIntervalId);
      document.removeEventListener(
        "visibilitychange",
        handleActivityStateChange
      );
      window.removeEventListener("focus", handleActivityStateChange);
      window.removeEventListener("blur", scheduleRefresh);
    };
  }, []);
}

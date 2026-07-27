import { useEffect } from "react";

import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  type ImportedHistorySourceId,
  externalHistoryRescanSources,
} from "@src/api/tauri/externalHistory";
import { loadSessionRoster } from "@src/store/session";
import {
  dataSourceConfigAtom,
  dataSourceRosterSignaturesAtom,
  externalSessionsEnabledAtom,
  getSourceConfig,
} from "@src/store/session/dataSourceConfigAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  SIDEBAR_SESSION_ACTIVE_REFRESH_INTERVAL_MS,
  SIDEBAR_SESSION_IDLE_REFRESH_INTERVAL_MS,
} from "../sidebarConnectorUtils";

type SessionStore = ReturnType<typeof getInstrumentedStore>;

interface SidebarRescanFlight {
  scopeKey: string;
  promise: Promise<void>;
}

const rescanInFlightByStore = new WeakMap<SessionStore, SidebarRescanFlight>();

function getRescanScope(store: SessionStore): {
  scopeKey: string;
  sourceIds: ImportedHistorySourceId[];
} {
  if (!store.get(externalSessionsEnabledAtom)) {
    return { scopeKey: "external-sessions-disabled", sourceIds: [] };
  }
  const config = store.get(dataSourceConfigAtom);
  const sourceIds = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.filter(
    ({ sourceId }) => getSourceConfig(config, sourceId).enabled
  ).map(({ sourceId }) => sourceId);
  return { scopeKey: JSON.stringify(sourceIds), sourceIds };
}

async function performSidebarSessionsRescan(
  store: SessionStore,
  sourceIds: readonly ImportedHistorySourceId[]
): Promise<void> {
  if (!store.get(externalSessionsEnabledAtom)) {
    // External sessions are switched off entirely — nothing to rescan, and
    // the sidebar reload below would be a no-op for external categories.
    await loadSessionRoster({ forceRefresh: true });
    return;
  }

  const scanResult = await externalHistoryRescanSources([...sourceIds]);
  // Explicit refresh: reload unconditionally. Even a rescan that wrote
  // nothing can follow cache writes from other surfaces' syncs (e.g. a
  // continuation demotion) that the sidebar never rendered.
  await loadSessionRoster({ forceRefresh: true });
  store.set(dataSourceRosterSignaturesAtom, (previous) => ({
    ...previous,
    ...(scanResult?.sourceSignatures ?? {}),
  }));

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

/** Coalesce overlapping refreshes without letting an obsolete scope win. */
export async function rescanSidebarSessions(): Promise<void> {
  const store = getInstrumentedStore();
  const { scopeKey, sourceIds } = getRescanScope(store);
  const inFlight = rescanInFlightByStore.get(store);
  if (inFlight) {
    if (inFlight.scopeKey === scopeKey) return inFlight.promise;
    try {
      await inFlight.promise;
    } catch {
      // A failed obsolete scope must not suppress the current source set.
    }
    return rescanSidebarSessions();
  }

  const pass = performSidebarSessionsRescan(store, sourceIds);
  rescanInFlightByStore.set(store, { scopeKey, promise: pass });
  try {
    await pass;
  } finally {
    if (rescanInFlightByStore.get(store)?.promise === pass) {
      rescanInFlightByStore.delete(store);
    }
  }
}

export function useSidebarSessionRefreshEffects(): void {
  useEffect(() => {
    void loadSessionRoster();
  }, []);

  useEffect(() => {
    let sidebarIntervalId: number | null = null;

    const getSidebarRefreshInterval = () =>
      document.hasFocus()
        ? SIDEBAR_SESSION_ACTIVE_REFRESH_INTERVAL_MS
        : SIDEBAR_SESSION_IDLE_REFRESH_INTERVAL_MS;

    const refreshAllSidebarSessions = () => {
      if (document.visibilityState !== "visible") return;
      void loadSessionRoster({ forceRefresh: true });
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

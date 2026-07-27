import { useEffect } from "react";

import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  type ImportedHistorySourceId,
  externalHistoryRescanSources,
} from "@src/api/tauri/externalHistory";
import { loadSidebarSessions } from "@src/store/session";
import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
  getSourceConfig,
} from "@src/store/session/dataSourceConfigAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

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
  const externalSessionsEnabled = store.get(externalSessionsEnabledAtom);
  if (!externalSessionsEnabled) {
    return { scopeKey: "external-sessions-disabled", sourceIds: [] };
  }
  const config = store.get(dataSourceConfigAtom);
  const sourceIds = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.filter(
    ({ sourceId }) => getSourceConfig(config, sourceId).enabled
  ).map(({ sourceId }) => sourceId);
  return { scopeKey: JSON.stringify(sourceIds), sourceIds };
}

/** Rescan every enabled external source, then reload the sidebar from cache. */
async function performSidebarSessionsRescan(
  store: SessionStore,
  sourceIds: readonly ImportedHistorySourceId[]
): Promise<void> {
  if (!store.get(externalSessionsEnabledAtom)) {
    // External sessions are switched off entirely — nothing to rescan, and
    // the sidebar reload below would be a no-op for external categories.
    await loadSidebarSessions({ forceRefresh: true });
    return;
  }

  await externalHistoryRescanSources([...sourceIds]);
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

/**
 * Keep rapid refresh clicks and overlapping callers on one scan/load chain.
 * The shared promise is scoped to the active Jotai store and released on both
 * success and failure so the next deliberate refresh can retry.
 */
export async function rescanSidebarSessions(): Promise<void> {
  const store = getInstrumentedStore();
  const { scopeKey, sourceIds } = getRescanScope(store);
  const inFlight = rescanInFlightByStore.get(store);
  if (inFlight) {
    if (inFlight.scopeKey === scopeKey) return inFlight.promise;
    try {
      await inFlight.promise;
    } catch {
      // Do not let a failed obsolete scope suppress the current source set.
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
    void loadSidebarSessions({ forceRefresh: true });
  }, []);
}

import { useEffect } from "react";

import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
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

/** Rescan every enabled external source, then refresh the canonical roster. */
export async function rescanSidebarSessions(): Promise<void> {
  const store = getInstrumentedStore();
  if (!store.get(externalSessionsEnabledAtom)) {
    // External sessions are switched off entirely — nothing to rescan, and
    // the sidebar reload below would be a no-op for external categories.
    await loadSessionRoster({ forceRefresh: true });
    return;
  }
  const config = store.get(dataSourceConfigAtom);
  const sourceIds = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.filter(
    ({ sourceId }) => getSourceConfig(config, sourceId).enabled
  ).map(({ sourceId }) => sourceId);

  const scanResult = await externalHistoryRescanSources(sourceIds);
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

export function useSidebarSessionRefreshEffects(): void {
  useEffect(() => {
    void loadSessionRoster();
  }, []);
}

/**
 * useDataSourceAutoScan
 *
 * App-wide scheduler that keeps external-history sources fresh. Mounted once in
 * AppBootstrap so it runs regardless of whether the Data Sources panel is open.
 *
 * On app startup it immediately scans each enabled, non-manual importable source
 * once, regardless of the persisted last-scan timestamp. Subsequent ticks scan
 * only sources whose effective cadence (per-source override, else the global
 * frequency) has elapsed. Each successful scan is followed by one unified
 * sidebar cache reload and stamps `lastScannedAt` on the scanned sources. The
 * underlying reader delta-syncs by file mtime, so unchanged sessions are cheap.
 * Sources set to "manual" are never auto-scanned, including at startup.
 *
 * Config is read straight from the shared store on each tick, so the interval is
 * armed once and always sees the latest values without re-arming.
 */
import { useEffect } from "react";

import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  externalHistoryRescanSources,
} from "@src/api/tauri/externalHistory";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import {
  isWindowFocused,
  onWindowFocusRegained,
} from "@src/util/core/windowFocus";

import {
  FREQUENCY_INTERVAL_MS,
  dataSourceConfigAtom,
  dataSourceGlobalFrequencyAtom,
  effectiveFrequency,
  externalSessionsEnabledAtom,
  getSourceConfig,
} from "./dataSourceConfigAtom";
import { loadSidebarSessions } from "./sessionAtom/loaders";

// Base cadence of the scheduler's own tick. The shortest source cadence is 60s,
// so a 30s tick keeps drift small without frequent wakeups.
const TICK_MS = 30_000;

// While the window is unfocused, every source's effective cadence is stretched
// to at least this floor (mirrors the backend git poller's focus-adaptive
// polling): rescans + the sidebar reload they trigger are wasted while nobody
// is looking. Regaining focus runs a pass immediately, so anything that came
// due in the background catches up right away.
const UNFOCUSED_SCAN_INTERVAL_MS = 10 * 60_000;

let autoScanInFlight: Promise<void> | null = null;

async function performDataSourceAutoScan(force: boolean): Promise<void> {
  const store = getInstrumentedStore();
  // Master switch: external sessions fully off — no scans, including startup.
  if (!store.get(externalSessionsEnabledAtom)) return;
  const cfgMap = store.get(dataSourceConfigAtom);
  const global = store.get(dataSourceGlobalFrequencyAtom);
  const now = Date.now();

  const focused = isWindowFocused();
  const dueSourceIds = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.flatMap(
    ({ sourceId }) => {
      const cfg = getSourceConfig(cfgMap, sourceId);
      if (!cfg.enabled) return [];
      const interval = FREQUENCY_INTERVAL_MS[effectiveFrequency(cfg, global)];
      if (interval == null) return [];
      const effectiveInterval = focused
        ? interval
        : Math.max(interval, UNFOCUSED_SCAN_INTERVAL_MS);
      const due =
        force ||
        cfg.lastScannedAt == null ||
        now - cfg.lastScannedAt >= effectiveInterval;
      return due ? [sourceId] : [];
    }
  );
  if (dueSourceIds.length === 0) return;

  await externalHistoryRescanSources(dueSourceIds);
  await loadSidebarSessions({ forceRefresh: true });

  const scannedAt = Date.now();
  store.set(dataSourceConfigAtom, (prev) => {
    const next = { ...prev };
    for (const sourceId of dueSourceIds) {
      next[sourceId] = {
        ...getSourceConfig(prev, sourceId),
        lastScannedAt: scannedAt,
      };
    }
    return next;
  });
}

/** Run one deduplicated auto-scan pass. `force` is reserved for app startup. */
export async function runDataSourceAutoScan(force = false): Promise<void> {
  if (autoScanInFlight) return autoScanInFlight;

  const pass = performDataSourceAutoScan(force);
  autoScanInFlight = pass;
  try {
    await pass;
  } finally {
    if (autoScanInFlight === pass) autoScanInFlight = null;
  }
}

export function useDataSourceAutoScan(): void {
  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;

    const scan = async (force = false) => {
      try {
        await runDataSourceAutoScan(force);
      } catch {
        /* transient; next tick retries */
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(() => void scan(), TICK_MS);
        }
      }
    };

    void scan(true);
    // Catch-up pass the moment focus returns: the tick itself keeps running
    // while unfocused (cheap due-check), but sources are held to the 10-minute
    // background floor — this runs anything that came due at its normal
    // cadence immediately. Runs outside the timer chain so it never re-arms
    // a second timeout loop; runDataSourceAutoScan dedupes concurrent passes.
    const unsubscribeFocus = onWindowFocusRegained(() => {
      if (!cancelled) void runDataSourceAutoScan(false);
    });
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      unsubscribeFocus();
    };
  }, []);
}

/**
 * useDataSourceAutoScan
 *
 * App-wide scheduler that keeps external-history sources fresh. Mounted once in
 * AppBootstrap so it runs regardless of whether the Data Sources panel is open.
 *
 * On app startup it immediately scans each enabled, non-manual importable source
 * with an on-disk history store once, regardless of the persisted last-scan
 * timestamp. Sources without a store receive only a cheap presence probe every
 * 30 minutes; when a store appears, its importer runs immediately. Subsequent
 * full scans use the effective per-source/global cadence. Each successful full
 * scan is followed by one unified sidebar cache reload. Sources set to "manual"
 * are never auto-scanned or presence-probed, including at startup.
 *
 * Config is read straight from the shared store on each tick, so the interval is
 * armed once and always sees the latest values without re-arming. The timer is
 * paused while the document is hidden and catches up immediately on return.
 */
import { useEffect } from "react";

import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  externalCliSourceProbe,
  externalHistoryRescanSources,
} from "@src/api/tauri/externalHistory";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { isWindowFocused } from "@src/util/core/windowFocus";

import {
  FREQUENCY_INTERVAL_MS,
  dataSourceConfigAtom,
  dataSourceGlobalFrequencyAtom,
  dataSourcePresenceAtom,
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

/** Cadence for refreshing the lightweight store-presence snapshot. */
const SOURCE_PRESENCE_PROBE_INTERVAL_MS = 30 * 60_000;

let autoScanInFlight: Promise<void> | null = null;

async function performDataSourceAutoScan(force: boolean): Promise<void> {
  const store = getInstrumentedStore();
  // Master switch: external sessions fully off — no scans, including startup.
  if (!store.get(externalSessionsEnabledAtom)) return;
  const cfgMap = store.get(dataSourceConfigAtom);
  const previousPresence = store.get(dataSourcePresenceAtom);
  const global = store.get(dataSourceGlobalFrequencyAtom);
  const now = Date.now();

  const focused = isWindowFocused();
  const candidates = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.flatMap(
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
      return [{ sourceId, scanDue: due }];
    }
  );
  if (candidates.length === 0) return;

  // Presence is checked independently from the full-import cadence. Confirmed
  // absent stores are held to a 30-minute probe; present stores are re-probed
  // on that same cadence so an uninstall/removal eventually stops full scans.
  const probeSourceIds = candidates.flatMap(({ sourceId }) => {
    const presence = previousPresence[sourceId];
    const probeDue =
      force ||
      presence == null ||
      now - presence.checkedAt >= SOURCE_PRESENCE_PROBE_INTERVAL_MS;
    return probeDue ? [sourceId] : [];
  });
  const probeResults = await Promise.allSettled(
    probeSourceIds.map(async (sourceId) => ({
      sourceId,
      probe: await externalCliSourceProbe(sourceId),
    }))
  );
  const successfulProbes = new Map<string, boolean>();
  for (const result of probeResults) {
    if (result.status === "fulfilled" && result.value.probe) {
      successfulProbes.set(
        result.value.sourceId,
        result.value.probe.historyFound
      );
    }
  }
  if (successfulProbes.size > 0) {
    store.set(dataSourcePresenceAtom, (previous) => {
      const next = { ...previous };
      for (const [sourceId, historyFound] of successfulProbes) {
        next[sourceId] = { historyFound, checkedAt: now };
      }
      return next;
    });
  }

  const currentPresence = store.get(dataSourcePresenceAtom);
  const dueSourceIds = candidates.flatMap(({ sourceId, scanDue }) => {
    const before = previousPresence[sourceId];
    const presence = currentPresence[sourceId];
    const newlyAvailable =
      before?.historyFound === false && presence?.historyFound === true;
    // Unknown presence is deliberately allowed through: a failed detector
    // must degrade to the previous full-scan behavior, not hide user history.
    const canScan = presence?.historyFound !== false;
    return canScan && (scanDue || newlyAvailable) ? [sourceId] : [];
  });

  // A successful negative probe is still a completed scheduler check and is
  // surfaced as "Last scan" in the Runtime pane, even though no importer ran.
  const absentProbeIds = [...successfulProbes].flatMap(
    ([sourceId, historyFound]) => (historyFound ? [] : [sourceId])
  );
  if (absentProbeIds.length > 0) {
    store.set(dataSourceConfigAtom, (previous) => {
      const next = { ...previous };
      for (const sourceId of absentProbeIds) {
        next[sourceId] = {
          ...getSourceConfig(previous, sourceId),
          lastScannedAt: now,
        };
      }
      return next;
    });
  }

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

interface DataSourceAutoScanVisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

interface DataSourceAutoScanScheduler {
  trigger(force?: boolean): void;
  stop(): void;
}

/**
 * Own the scheduler's one recursive timeout. Hidden documents clear the timer;
 * becoming visible triggers one immediate catch-up pass and re-arms the chain.
 */
export function startDataSourceAutoScanScheduler(
  source: DataSourceAutoScanVisibilitySource,
  scan: (force?: boolean) => Promise<void>,
  intervalMs = TICK_MS
): DataSourceAutoScanScheduler {
  let stopped = false;
  let startupPending = true;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timeoutId === undefined) return;
    clearTimeout(timeoutId);
    timeoutId = undefined;
  };
  const schedule = () => {
    clearTimer();
    if (stopped || source.visibilityState === "hidden") return;
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      trigger();
    }, intervalMs);
  };
  const trigger = (force = false) => {
    clearTimer();
    if (stopped || source.visibilityState === "hidden") return;
    const shouldForce = startupPending || force;
    startupPending = false;
    void scan(shouldForce)
      .catch(() => {
        /* transient; next tick retries */
      })
      .finally(schedule);
  };
  const onVisibilityChange = () => {
    clearTimer();
    if (source.visibilityState !== "hidden") trigger();
  };

  source.addEventListener("visibilitychange", onVisibilityChange);
  trigger(true);
  return {
    trigger,
    stop: () => {
      stopped = true;
      clearTimer();
      source.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}

export function useDataSourceAutoScan(): void {
  useEffect(() => {
    const scheduler = startDataSourceAutoScanScheduler(
      document,
      runDataSourceAutoScan
    );
    // A visible but unfocused window retains the low-frequency background
    // safety floor. Regaining focus immediately checks foreground cadences.
    const onFocus = () => scheduler.trigger();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      scheduler.stop();
    };
  }, []);
}

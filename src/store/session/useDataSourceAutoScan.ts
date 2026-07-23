/**
 * useDataSourceAutoScan
 *
 * App-wide scheduler that keeps external-history sources fresh. Mounted once in
 * AppBootstrap so it runs regardless of whether the Data Sources panel is open.
 *
 * On app startup it scans only enabled, non-manual importable sources whose
 * persisted cadence is due (including sources that have never been scanned).
 * Sources without a store receive only a cheap presence probe every 30 minutes;
 * when a store appears, its importer runs immediately. A successful full scan
 * reloads the external-history sidebar cache only when source data changed.
 * Sources set to "manual" are never auto-scanned or presence-probed, including
 * at startup.
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
import {
  isWindowFocused,
  onWindowFocusRegained,
} from "@src/util/core/windowFocus";

import {
  type DataSourceConfigMap,
  type DataSourcePresence,
  FREQUENCY_INTERVAL_MS,
  type ScanFrequency,
  dataSourceConfigAtom,
  dataSourceGlobalFrequencyAtom,
  dataSourcePresenceAtom,
  effectiveFrequency,
  externalSessionsEnabledAtom,
  getSourceConfig,
} from "./dataSourceConfigAtom";
import { loadExternalHistorySidebarSessions } from "./sessionAtom/loaders";

// While the window is unfocused, every source's effective cadence is stretched
// to at least this floor (mirrors the backend git poller's focus-adaptive
// polling): rescans + the sidebar reload they trigger are wasted while nobody
// is looking. Regaining focus runs a pass immediately, so anything that came
// due in the background catches up right away.
const UNFOCUSED_SCAN_INTERVAL_MS = 10 * 60_000;

/** Cadence for refreshing the lightweight store-presence snapshot. */
const SOURCE_PRESENCE_PROBE_INTERVAL_MS = 30 * 60_000;
const FAILED_SCAN_RETRY_MS = 30_000;

let autoScanInFlight: Promise<void> | null = null;

async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await mapper(items[index]!),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      worker
    )
  );
  return results;
}

export function nextDataSourceAutoScanDelay(
  now: number,
  focused: boolean,
  enabled: boolean,
  cfgMap: DataSourceConfigMap,
  previousPresence: Record<string, DataSourcePresence>,
  global: ScanFrequency
): number | null {
  if (!enabled) return null;
  let earliestDeadline: number | null = null;
  for (const { sourceId } of IMPORTED_HISTORY_SOURCE_DESCRIPTORS) {
    const cfg = getSourceConfig(cfgMap, sourceId);
    if (!cfg.enabled) continue;
    const interval = FREQUENCY_INTERVAL_MS[effectiveFrequency(cfg, global)];
    if (interval == null) continue;

    const presence = previousPresence[sourceId];
    const probeDeadline =
      presence == null
        ? now
        : presence.checkedAt + SOURCE_PRESENCE_PROBE_INTERVAL_MS;
    const effectiveInterval = focused
      ? interval
      : Math.max(interval, UNFOCUSED_SCAN_INTERVAL_MS);
    const scanDeadline =
      cfg.lastScannedAt == null ? now : cfg.lastScannedAt + effectiveInterval;
    const deadline =
      presence?.historyFound === false
        ? probeDeadline
        : Math.min(scanDeadline, probeDeadline);
    earliestDeadline =
      earliestDeadline == null
        ? deadline
        : Math.min(earliestDeadline, deadline);
  }
  return earliestDeadline == null ? null : Math.max(0, earliestDeadline - now);
}

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
  const probeResults = await mapSettledWithConcurrency(
    probeSourceIds,
    2,
    async (sourceId) => ({
      sourceId,
      probe: await externalCliSourceProbe(sourceId),
    })
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
  const scanResult = await externalHistoryRescanSources(dueSourceIds);
  if (scanResult.changedSources.length > 0) {
    await loadExternalHistorySidebarSessions();
  }

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

/** Run one deduplicated auto-scan pass. `force` is reserved for explicit refreshes. */
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
  schedule(): void;
  stop(): void;
}

/**
 * Own the scheduler's one exact-deadline timeout. Hidden documents clear the
 * timer; becoming visible triggers one immediate due-check and re-arms the
 * chain. Failed scans retry after a bounded delay without creating a second
 * timer or overlapping an active scan.
 */
export function startDataSourceAutoScanScheduler(
  source: DataSourceAutoScanVisibilitySource,
  scan: (force?: boolean) => Promise<void>,
  nextDelay: () => number | null,
  failedScanRetryMs = FAILED_SCAN_RETRY_MS
): DataSourceAutoScanScheduler {
  let stopped = false;
  let running = false;
  let retryNotBefore = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timeoutId === undefined) return;
    clearTimeout(timeoutId);
    timeoutId = undefined;
  };
  const schedule = () => {
    clearTimer();
    if (stopped || running || source.visibilityState === "hidden") return;
    const delay = nextDelay();
    if (delay == null) return;
    timeoutId = setTimeout(
      () => {
        timeoutId = undefined;
        trigger();
      },
      Math.max(1, delay, retryNotBefore - Date.now())
    );
  };
  const trigger = (force = false) => {
    clearTimer();
    if (stopped || running || source.visibilityState === "hidden") return;
    running = true;
    void scan(force)
      .then(
        () => {
          retryNotBefore = 0;
        },
        () => {
          retryNotBefore = Date.now() + failedScanRetryMs;
        }
      )
      .finally(() => {
        running = false;
        schedule();
      });
  };
  const onVisibilityChange = () => {
    clearTimer();
    if (source.visibilityState !== "hidden") trigger();
  };

  source.addEventListener("visibilitychange", onVisibilityChange);
  // Respect persisted per-source cadences on relaunch. Explicit refreshes can
  // still request a forced pass through trigger(true).
  trigger();
  return {
    trigger,
    schedule,
    stop: () => {
      stopped = true;
      clearTimer();
      source.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}

export function useDataSourceAutoScan(): void {
  useEffect(() => {
    const store = getInstrumentedStore();
    const scheduler = startDataSourceAutoScanScheduler(
      document,
      runDataSourceAutoScan,
      () =>
        nextDataSourceAutoScanDelay(
          Date.now(),
          isWindowFocused(),
          store.get(externalSessionsEnabledAtom),
          store.get(dataSourceConfigAtom),
          store.get(dataSourcePresenceAtom),
          store.get(dataSourceGlobalFrequencyAtom)
        )
    );
    // A visible but unfocused window retains the low-frequency background
    // safety floor. Regaining focus immediately checks foreground cadences.
    const unsubscribeFocus = onWindowFocusRegained(() => {
      scheduler.trigger();
    });
    const unsubscribers = [
      store.sub(dataSourceConfigAtom, scheduler.schedule),
      store.sub(dataSourcePresenceAtom, scheduler.schedule),
      store.sub(dataSourceGlobalFrequencyAtom, scheduler.schedule),
      store.sub(externalSessionsEnabledAtom, scheduler.schedule),
    ];
    return () => {
      unsubscribeFocus();
      scheduler.stop();
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, []);
}

import { invoke } from "@tauri-apps/api/core";

import type { ImportedHistorySourceId } from "./imported/descriptors";

export interface ExternalHistoryScanResult {
  changedSources: ImportedHistorySourceId[];
  /**
   * Whole-source cache signatures for every rescanned source, changed or not.
   * `changedSources` only reports writes made by the rescan call itself;
   * other surfaces sync the same backend cache between scheduler ticks, so
   * callers compare these signatures against the ones captured at their last
   * roster reload to detect staleness the rescan alone cannot see.
   */
  sourceSignatures: Record<string, string>;
}

interface PendingScanWaiter {
  resolve: (result: ExternalHistoryScanResult) => void;
  reject: (error: unknown) => void;
}

const pendingSources = new Set<ImportedHistorySourceId>();
const pendingClearSources = new Set<ImportedHistorySourceId>();
let pendingWaiters: PendingScanWaiter[] = [];
let scanDrainPromise: Promise<void> | null = null;
let activeSources: ReadonlySet<ImportedHistorySourceId> | null = null;
let activeClearSources: ReadonlySet<ImportedHistorySourceId> | null = null;
let activeBatchPromise: Promise<ExternalHistoryScanResult> | null = null;

function normalizeScanResult(
  result: ExternalHistoryScanResult | undefined,
  fallbackSources: readonly ImportedHistorySourceId[]
): ExternalHistoryScanResult {
  // The fallback keeps older native builds and lightweight test doubles safe:
  // if no result payload exists, assume changed and perform the downstream
  // refresh rather than risking stale UI. A payload without signatures (older
  // native build) degrades to signature-blind change reporting.
  if (!result) {
    return { changedSources: [...fallbackSources], sourceSignatures: {} };
  }
  return {
    changedSources: result.changedSources ?? [...fallbackSources],
    sourceSignatures: result.sourceSignatures ?? {},
  };
}

function mergeScanResults(
  results: readonly ExternalHistoryScanResult[]
): ExternalHistoryScanResult {
  return {
    changedSources: [
      ...new Set(results.flatMap(({ changedSources }) => changedSources)),
    ],
    sourceSignatures: Object.assign(
      {},
      ...results.map(({ sourceSignatures }) => sourceSignatures ?? {})
    ) as Record<string, string>,
  };
}

async function runScanBatch(
  sources: readonly ImportedHistorySourceId[],
  clearSources: ReadonlySet<ImportedHistorySourceId>
): Promise<ExternalHistoryScanResult> {
  const results: ExternalHistoryScanResult[] = [];
  // Clear/rebuild is intentionally source-scoped; applying the batch command's
  // single `clear` flag would force unrelated incremental sources to rebuild.
  for (const source of sources) {
    if (!clearSources.has(source)) continue;
    results.push(
      normalizeScanResult(
        await invoke<ExternalHistoryScanResult>(
          "external_history_rescan_source",
          { source, clear: true }
        ),
        [source]
      )
    );
  }
  const incrementalSources = sources.filter(
    (source) => !clearSources.has(source)
  );
  if (incrementalSources.length > 0) {
    results.push(
      normalizeScanResult(
        await invoke<ExternalHistoryScanResult>(
          "external_history_rescan_sources",
          {
            sources: incrementalSources,
            clear: false,
          }
        ),
        incrementalSources
      )
    );
  }
  return mergeScanResults(results);
}

function startScanDrain(): void {
  if (scanDrainPromise) return;
  scanDrainPromise = Promise.resolve()
    .then(async () => {
      while (pendingSources.size > 0) {
        const sources = [...pendingSources];
        const clearSources = new Set(pendingClearSources);
        const waiters = pendingWaiters;
        pendingSources.clear();
        pendingClearSources.clear();
        pendingWaiters = [];

        activeSources = new Set(sources);
        activeClearSources = clearSources;
        const batch = runScanBatch(sources, clearSources);
        activeBatchPromise = batch;
        try {
          const result = await batch;
          waiters.forEach(({ resolve }) => resolve(result));
        } catch (error) {
          waiters.forEach(({ reject }) => reject(error));
        } finally {
          activeSources = null;
          activeClearSources = null;
          activeBatchPromise = null;
        }
      }
    })
    .finally(() => {
      scanDrainPromise = null;
      // A request can arrive between the loop's final check and this cleanup.
      if (pendingSources.size > 0) startScanDrain();
    });
}

function enqueueExternalHistoryScan(
  requestedSources: readonly ImportedHistorySourceId[],
  clear: boolean
): Promise<ExternalHistoryScanResult> {
  const sources = [...new Set(requestedSources)];
  if (sources.length === 0) {
    return Promise.resolve({ changedSources: [], sourceSignatures: {} });
  }

  const joinsActive = sources.filter(
    (source) =>
      activeSources?.has(source) && (!clear || activeClearSources?.has(source))
  );
  const queuedSources = sources.filter(
    (source) => !joinsActive.includes(source)
  );
  if (queuedSources.length === 0 && activeBatchPromise) {
    return activeBatchPromise;
  }

  const request = new Promise<ExternalHistoryScanResult>((resolve, reject) => {
    for (const source of queuedSources) {
      pendingSources.add(source);
      if (clear) pendingClearSources.add(source);
    }
    pendingWaiters.push({ resolve, reject });
  });
  startScanDrain();
  return joinsActive.length > 0 && activeBatchPromise
    ? Promise.all([activeBatchPromise, request]).then(mergeScanResults)
    : request;
}

/**
 * Rescan a single external history source, re-reading its on-disk store and
 * repopulating the metadata cache.
 *
 * - `clear: false` (default) — **update**: incrementally re-sync, re-parsing
 *   only sessions whose on-disk signature changed (e.g. after a parser-version
 *   bump). Fast and non-destructive.
 * - `clear: true` — **clear + rescan**: wipe the source's cached rows first,
 *   then re-parse everything from scratch. Use to drop stale rows or force a
 *   full rebuild.
 *
 * Both modes leave the cache populated, so callers can immediately re-read the
 * count / sidebar without a separate lazy load.
 */
export async function externalHistoryRescanSource(
  source: ImportedHistorySourceId,
  options?: { clear?: boolean }
): Promise<ExternalHistoryScanResult> {
  return enqueueExternalHistoryScan([source], options?.clear ?? false);
}

/**
 * Rescan multiple external-history sources as one user action.
 *
 * Keeping the fan-out here gives every "rescan all" entry point the same
 * backend behavior while the Rust command remains intentionally source-scoped.
 */
export async function externalHistoryRescanSources(
  sources: readonly ImportedHistorySourceId[]
): Promise<ExternalHistoryScanResult> {
  return enqueueExternalHistoryScan(sources, false);
}

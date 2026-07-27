import { invoke } from "@tauri-apps/api/core";

import type { ImportedHistorySourceId } from "./imported/descriptors";

interface ActiveRescan {
  clear: boolean;
  promise: Promise<void>;
  trailingClear?: Promise<void>;
}

const activeRescans = new Map<ImportedHistorySourceId, ActiveRescan>();

function uniqueSources(
  sources: readonly ImportedHistorySourceId[]
): ImportedHistorySourceId[] {
  return [...new Set(sources)];
}

async function invokeRescan(
  sources: readonly ImportedHistorySourceId[],
  clear: boolean
): Promise<void> {
  if (sources.length === 1) {
    await invoke("external_history_rescan_source", {
      source: sources[0],
      clear,
    });
    return;
  }

  if (!clear) {
    await invoke("external_history_rescan_sources", {
      sources,
      clear: false,
    });
    return;
  }

  await Promise.all(
    sources.map((source) =>
      invoke("external_history_rescan_source", { source, clear: true })
    )
  );
}

/**
 * Coordinate rescans at the API ownership boundary so callers from the
 * sidebar, auto-scan hook, and Data Sources panel share the same work.
 *
 * A clear rescan cannot join an incremental rescan because it has stronger
 * semantics. It waits for the incremental pass and then runs exactly once.
 */
async function coordinateRescan(
  requestedSources: readonly ImportedHistorySourceId[],
  clear: boolean
): Promise<void> {
  const sources = uniqueSources(requestedSources);
  if (sources.length === 0) return;

  const joined = new Set<Promise<void>>();
  const toStart: ImportedHistorySourceId[] = [];

  for (const source of sources) {
    const active = activeRescans.get(source);
    if (!active) {
      toStart.push(source);
    } else if (!clear || active.clear) {
      joined.add(active.promise);
    } else {
      active.trailingClear ??= active.promise
        .catch(() => undefined)
        .then(() => coordinateRescan([source], true));
      joined.add(active.trailingClear);
    }
  }

  if (toStart.length > 0) {
    const started = invokeRescan(toStart, clear);
    const entry: ActiveRescan = { clear, promise: started };
    const tracked = started.finally(() => {
      for (const source of toStart) {
        if (activeRescans.get(source) === entry) {
          activeRescans.delete(source);
        }
      }
    });
    entry.promise = tracked;
    for (const source of toStart) {
      activeRescans.set(source, entry);
    }
    joined.add(tracked);
  }

  await Promise.all(joined);
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
): Promise<void> {
  await coordinateRescan([source], options?.clear ?? false);
}

/**
 * Rescan multiple external-history sources as one user action.
 *
 * Keeping the fan-out here gives every "rescan all" entry point the same
 * backend behavior while the Rust command remains intentionally source-scoped.
 */
export async function externalHistoryRescanSources(
  sources: readonly ImportedHistorySourceId[]
): Promise<void> {
  await coordinateRescan(sources, false);
}

export const __TESTS_ONLY = {
  activeRescanCount: () => activeRescans.size,
  reset: () => activeRescans.clear(),
};

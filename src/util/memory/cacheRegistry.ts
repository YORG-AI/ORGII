/**
 * Cache registry — the single ledger of in-webview caches.
 *
 * Every module-level cache that can hold more than a trivial amount of memory
 * registers itself here with a byte estimator and, when it can safely drop
 * its contents, a trim callback. The registry has two consumers:
 *
 *   1. The RAM monitor (dev mode) lists every registered cache with its live
 *      byte estimate, so an unbounded or leaking cache shows up by name
 *      instead of as an anonymous slice of the WebContent footprint.
 *   2. Memory-pressure handling calls `trimRegisteredCaches` to shed caches
 *      by tier, lowest tier first.
 *
 * Tiers:
 *   0 — derived data that is cheap to recompute (rendered SVG, parsed markdown)
 *   1 — replay caches whose source of truth lives in Rust (snapshots, turn
 *       bodies, terminal scrollback, screenshots); a trim costs one IPC refetch
 *   2 — state of hidden views kept alive for fast switching
 *
 * Registration is a module-evaluation side effect, so it survives HMR: a
 * re-registration with the same id replaces the previous entry.
 */

export type CacheTier = 0 | 1 | 2;

export type CachePressureLevel = "moderate" | "critical";

export interface CacheEstimate {
  /** Estimated retained bytes. */
  bytes: number;
  /** Number of cached items, when the cache has a natural item count. */
  entries?: number;
}

export interface CacheRegistration {
  /** Stable dotted id, e.g. `terminal.bufferCache`. */
  id: string;
  tier: CacheTier;
  estimate: () => CacheEstimate;
  /**
   * Drop contents for the given pressure level. Optional: caches with their
   * own release timers may expose an estimate only.
   */
  trim?: (level: CachePressureLevel) => void;
}

export interface CacheRegistryEntryReport {
  id: string;
  tier: CacheTier;
  bytes: number;
  entries: number | null;
  canTrim: boolean;
  lastTrimmedAt: number | null;
  /** True when `estimate()` threw; `bytes` is 0 in that case. */
  estimateFailed: boolean;
}

export interface CacheTrimResult {
  id: string;
  bytesBefore: number;
  bytesAfter: number;
  /** True when `trim()` threw. */
  failed: boolean;
}

interface RegistryEntry {
  registration: CacheRegistration;
  lastTrimmedAt: number | null;
}

const entries = new Map<string, RegistryEntry>();

const MAX_TIER_FOR_LEVEL: Record<CachePressureLevel, CacheTier> = {
  moderate: 1,
  critical: 2,
};

function safeEstimate(registration: CacheRegistration): {
  estimate: CacheEstimate;
  failed: boolean;
} {
  try {
    const estimate = registration.estimate();
    const bytes = Number.isFinite(estimate.bytes)
      ? Math.max(0, estimate.bytes)
      : 0;
    return { estimate: { ...estimate, bytes }, failed: false };
  } catch {
    return { estimate: { bytes: 0 }, failed: true };
  }
}

/**
 * Register a cache. Returns an unregister function. Re-registering an id
 * replaces the previous registration (HMR-friendly).
 */
export function registerCache(registration: CacheRegistration): () => void {
  entries.set(registration.id, { registration, lastTrimmedAt: null });
  return () => {
    const current = entries.get(registration.id);
    if (current?.registration === registration) {
      entries.delete(registration.id);
    }
  };
}

/** Snapshot of every registered cache, largest first. */
export function listRegisteredCaches(): CacheRegistryEntryReport[] {
  const reports: CacheRegistryEntryReport[] = [];
  for (const [id, entry] of entries) {
    const { estimate, failed } = safeEstimate(entry.registration);
    reports.push({
      id,
      tier: entry.registration.tier,
      bytes: estimate.bytes,
      entries: estimate.entries ?? null,
      canTrim: typeof entry.registration.trim === "function",
      lastTrimmedAt: entry.lastTrimmedAt,
      estimateFailed: failed,
    });
  }
  return reports.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
}

/**
 * Trim every trimmable cache at or below the tier for `level`
 * (`moderate` → tiers 0–1, `critical` → all tiers), lowest tier first.
 */
export function trimRegisteredCaches(
  level: CachePressureLevel,
  now: number = Date.now()
): CacheTrimResult[] {
  const maxTier = MAX_TIER_FOR_LEVEL[level];
  const candidates = [...entries.values()]
    .filter(
      (entry) =>
        entry.registration.tier <= maxTier &&
        typeof entry.registration.trim === "function"
    )
    .sort((a, b) => a.registration.tier - b.registration.tier);

  return candidates.map((entry) => {
    const { registration } = entry;
    const bytesBefore = safeEstimate(registration).estimate.bytes;
    let failed = false;
    try {
      registration.trim?.(level);
      entry.lastTrimmedAt = now;
    } catch {
      failed = true;
    }
    const bytesAfter = safeEstimate(registration).estimate.bytes;
    return { id: registration.id, bytesBefore, bytesAfter, failed };
  });
}

/** Test-only: forget every registration. */
export function __resetCacheRegistryForTests(): void {
  entries.clear();
}

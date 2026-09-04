/**
 * useKeepAliveWindow — bounded keep-alive for tab-like content.
 *
 * "Hide with `display: none`" keeps every tab ever opened mounted, which is
 * how a chat pane with ten terminal tabs ends up holding ten xterm buffers.
 * This hook answers the question "which keys may stay mounted right now?":
 *
 *   - the active key, always;
 *   - keys deactivated less than `graceMs` ago, so flipping between two tabs
 *     stays instant and pays no rebuild;
 *   - at most `maxWarm` keys in total (active + most recently deactivated).
 *
 * Everything else should be unmounted and rebuilt from state when it becomes
 * active again. Keys that leave `presentKeys` (tab closed) drop immediately.
 *
 * The active-key transition uses React's "adjust state during render"
 * pattern; only the grace expiry runs through a timer.
 */
import { useEffect, useMemo, useState } from "react";

export interface KeepAliveWindowOptions {
  /** How long a deactivated key stays warm, in milliseconds. */
  graceMs: number;
  /** Upper bound on warm keys including the active one. Default: unbounded. */
  maxWarm?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** Marker for the active key: never expires on its own. */
const ACTIVE = Number.POSITIVE_INFINITY;

type WarmEntries = ReadonlyMap<string, number>;

function transition(
  entries: WarmEntries,
  previousActive: string | null,
  nextActive: string | null,
  now: number,
  maxWarm: number | undefined
): WarmEntries {
  const next = new Map(entries);
  if (previousActive !== null && previousActive !== nextActive) {
    next.set(previousActive, now);
  }
  if (nextActive !== null) {
    next.set(nextActive, ACTIVE);
  }
  if (maxWarm !== undefined && next.size > maxWarm) {
    // Drop the least recently deactivated keys first; the active key is
    // +Infinity and therefore sorts last.
    const ordered = [...next.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key] of ordered.slice(0, next.size - Math.max(1, maxWarm))) {
      next.delete(key);
    }
  }
  return next;
}

function pruneExpired(
  entries: WarmEntries,
  graceMs: number,
  now: number
): WarmEntries {
  let changed = false;
  const next = new Map<string, number>();
  for (const [key, deactivatedAt] of entries) {
    if (deactivatedAt === ACTIVE || deactivatedAt + graceMs > now) {
      next.set(key, deactivatedAt);
    } else {
      changed = true;
    }
  }
  return changed ? next : entries;
}

export function useKeepAliveWindow(
  activeKey: string | null,
  presentKeys: readonly string[],
  options: KeepAliveWindowOptions
): ReadonlySet<string> {
  const { graceMs, maxWarm } = options;
  const now = options.now ?? Date.now;

  const [entries, setEntries] = useState<WarmEntries>(
    () => new Map(activeKey === null ? [] : [[activeKey, ACTIVE]])
  );
  const [lastActive, setLastActive] = useState(activeKey);
  if (activeKey !== lastActive) {
    setLastActive(activeKey);
    setEntries(transition(entries, lastActive, activeKey, now(), maxWarm));
  }

  // Grace expiry: wake up when the earliest warm key ages out.
  useEffect(() => {
    let earliest = ACTIVE;
    for (const deactivatedAt of entries.values()) {
      if (deactivatedAt < earliest) earliest = deactivatedAt;
    }
    if (earliest === ACTIVE) return undefined;
    const delay = Math.max(0, earliest + graceMs - now());
    const timer = setTimeout(() => {
      setEntries((current) => pruneExpired(current, graceMs, now()));
    }, delay);
    return () => clearTimeout(timer);
  }, [entries, graceMs, now]);

  return useMemo(() => {
    const present = new Set(presentKeys);
    const warm = new Set<string>();
    for (const key of entries.keys()) {
      if (present.has(key)) warm.add(key);
    }
    if (activeKey !== null && present.has(activeKey)) warm.add(activeKey);
    return warm;
  }, [entries, presentKeys, activeKey]);
}

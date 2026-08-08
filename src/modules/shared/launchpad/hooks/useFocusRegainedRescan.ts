import { useEffect, useRef } from "react";

/**
 * Launchpad discovery scans walk repo directories; a window-focus storm
 * (alt-tab flapping) must not multiply that disk work. One rescan per
 * cooldown window per hook — the mount-time scan effects own freshness
 * otherwise.
 */
export const LAUNCHPAD_FOCUS_RESCAN_COOLDOWN_MS = 30_000;

export function useFocusRegainedRescan(
  enabled: boolean,
  refresh: () => void,
  cooldownMs: number = LAUNCHPAD_FOCUS_RESCAN_COOLDOWN_MS
): void {
  const lastRunAtRef = useRef(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const handleFocus = () => {
      if (Date.now() - lastRunAtRef.current < cooldownMs) return;
      lastRunAtRef.current = Date.now();
      refresh();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [enabled, refresh, cooldownMs]);
}

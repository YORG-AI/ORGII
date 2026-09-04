import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";

import { useKeepAliveWindow } from "@src/hooks/ui/useKeepAliveWindow";
import { activeHostAtom } from "@src/store/workstation";
import { mainPaneHasRealTabsAtom } from "@src/store/workstation/tabHost";

export interface AppShellDockState {
  visitedModes: Set<string>;
}

/**
 * How long a host that the user left stays mounted-but-hidden. Long enough
 * to make "peek at the browser, come back to the editor" a style flip, short
 * enough that a host abandoned for the rest of the session — the file tree,
 * the browser layout with its DevTools, the project tables — stops holding
 * its subtree. The active host is never subject to this window.
 */
export const HOST_KEEP_ALIVE_GRACE_MS = 60_000;

/** Content hosts the window applies to; `agent-station` mounts iff displayed. */
const KEEP_ALIVE_HOSTS = ["code", "browser", "project"] as const;

interface AppShellDockSnapshot extends AppShellDockState {
  activeHost: string;
  hasRealTabs: boolean;
}

export function advanceAppShellDockSnapshot(
  previous: AppShellDockSnapshot,
  activeHost: string,
  hasRealTabs: boolean
): AppShellDockSnapshot {
  if (
    previous.activeHost === activeHost &&
    previous.hasRealTabs === hasRealTabs
  ) {
    return previous;
  }
  if (!hasRealTabs) {
    return {
      activeHost,
      hasRealTabs,
      visitedModes:
        previous.visitedModes.size === 0
          ? previous.visitedModes
          : new Set<string>(),
    };
  }
  return {
    activeHost,
    hasRealTabs,
    visitedModes: previous.visitedModes.has(activeHost)
      ? previous.visitedModes
      : new Set([...previous.visitedModes, activeHost]),
  };
}

/**
 * Tracks which content hosts have been visited since the tab pool last held
 * real work, so `AppShellContent` can keep them mounted-but-hidden for
 * instant tab switches.
 *
 * The keep-alive is bounded twice. When the pool empties down to the
 * Launchpad the visited set is cleared and every host unmounts, releasing its
 * subtree (and idle background work like the file-tree autoload). And a
 * visited host only stays warm for `HOST_KEEP_ALIVE_GRACE_MS` after the user
 * leaves it: a hidden host holds an entire surface (file tree and sidebars,
 * browser layout with DevTools, project tables), so one that is not returned
 * to within a minute is released and rebuilt from atom state on the next
 * visit. This is safe because the ACTIVE host never depends on this set —
 * `AppShellContent` mounts it through the synchronous `is*Mode` branch the
 * moment a tab activates — and because cross-surface requests travel through
 * atoms that survive host remounts.
 *
 * The old unconditional Browser pre-mount (so a "New Browser" click had a
 * mounted consumer) is gone: `AppShellContent` now mounts the Browser host
 * whenever a new-session request is pending or engine sessions exist — see
 * `shouldMountBrowserHost` in `../hostMountPolicy`.
 */
export function useAppShellDock(): AppShellDockState {
  const activeHost = useAtomValue(activeHostAtom);
  const hasRealTabs = useAtomValue(mainPaneHasRealTabsAtom);

  // Seed and advance the host history in render so a newly active host is
  // available in the same commit. The set is bounded by the three host names
  // and is cleared synchronously when the real-tab pool empties.
  const [snapshot, setSnapshot] = useState<AppShellDockSnapshot>(() => ({
    activeHost,
    hasRealTabs,
    visitedModes: hasRealTabs ? new Set([activeHost]) : new Set(),
  }));
  const nextSnapshot = advanceAppShellDockSnapshot(
    snapshot,
    activeHost,
    hasRealTabs
  );
  if (nextSnapshot !== snapshot) {
    setSnapshot(nextSnapshot);
  }
  // Grace window: a host the user left stays warm for a bounded time only.
  // With no real tabs the window is empty immediately, matching the
  // synchronous clear above.
  const warmHosts = useKeepAliveWindow(
    hasRealTabs ? activeHost : null,
    KEEP_ALIVE_HOSTS,
    { graceMs: HOST_KEEP_ALIVE_GRACE_MS }
  );
  const visitedModes = useMemo(() => {
    const result = new Set<string>();
    for (const host of nextSnapshot.visitedModes) {
      if (warmHosts.has(host)) result.add(host);
    }
    return result;
  }, [nextSnapshot.visitedModes, warmHosts]);
  return { visitedModes };
}

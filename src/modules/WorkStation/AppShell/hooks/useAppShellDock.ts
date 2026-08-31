import { useAtomValue } from "jotai";
import { useState } from "react";

import { activeHostAtom } from "@src/store/workstation";
import { mainPaneHasRealTabsAtom } from "@src/store/workstation/tabHost";

export interface AppShellDockState {
  visitedModes: Set<string>;
}

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
 * The keep-alive is bounded: when the pool empties down to the Launchpad the
 * visited set is cleared and every host unmounts, releasing its subtree (and
 * idle background work like the file-tree autoload). This is safe because the
 * ACTIVE host never depends on this set — `AppShellContent` mounts it through
 * the synchronous `is*Mode` branch the moment a tab activates — and because
 * cross-surface requests travel through atoms that survive host remounts.
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

  return { visitedModes: nextSnapshot.visitedModes };
}

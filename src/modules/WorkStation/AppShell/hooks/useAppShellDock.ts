import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";

import { activeHostAtom } from "@src/store/workstation";
import { mainPaneHasRealTabsAtom } from "@src/store/workstation/tabHost";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

export interface AppShellDockState {
  visitedModes: Set<string>;
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

  // Seed with the active tab's host on first render so the host pane that
  // owns a restored active tab is kept warm from the same commit (no blank
  // 40px header strip when switching away and back within the first frame).
  const [visitedModes, setVisitedModes] = useState<Set<string>>(() => {
    if (!hasRealTabs) return new Set();
    try {
      const store = getInstrumentedStore();
      return new Set([store.get(activeHostAtom)]);
    } catch {
      // Store not yet available in some test environments — fine.
      return new Set(["code"]);
    }
  });

  useEffect(() => {
    if (!hasRealTabs) {
      // Empty pool (Launchpad only): release every kept-alive host. The next
      // real tab re-mounts its host synchronously via the `is*Mode` branch in
      // AppShellContent, so clearing here never delays a visible surface.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisitedModes((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisitedModes((prev) =>
      prev.has(activeHost) ? prev : new Set([...prev, activeHost])
    );
  }, [activeHost, hasRealTabs]);

  return { visitedModes };
}

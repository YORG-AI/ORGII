import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import { activeHostAtom } from "@src/store/workstation";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

export interface AppShellDockState {
  visitedModes: Set<string>;
}

export function useAppShellDock(): AppShellDockState {
  const activeHost = useAtomValue(activeHostAtom);

  // Seed `visitedModes` with `"code"` (the fallback host for empty workstation
  // state) AND the active tab's host on first render. Without the eager seed
  // the host pane that owns the active tab mounts one frame late, leaving its
  // 40px header slot null and the global strip visibly blank until the rAF
  // below fires.
  const [visitedModes, setVisitedModes] = useState<Set<string>>(() => {
    const initial = new Set<string>(["code"]);
    try {
      const store = getInstrumentedStore();
      initial.add(store.get(activeHostAtom));
    } catch {
      // Store not yet available in some test environments — fine.
    }
    return initial;
  });

  // Track which hosts we've already enqueued to mount; lets us still use rAF
  // deferral for non-blocking first paint without re-running the effect on
  // every state change (see remix-run loop guidance).
  const enqueuedRef = useRef<Set<string>>(new Set(visitedModes));

  // `eager === true` flips the host synchronously so the keep-alive `<div>`
  // mounts in the same commit that swapped `activeHost`; the rAF path defers
  // hosts the user has not directly asked for yet, to avoid blocking first
  // paint with extra subtree work.
  const queueVisit = useCallback((host: string, eager: boolean) => {
    if (enqueuedRef.current.has(host)) return;
    enqueuedRef.current.add(host);
    if (eager) {
      setVisitedModes((prev) =>
        prev.has(host) ? prev : new Set([...prev, host])
      );
      return;
    }
    requestAnimationFrame(() => {
      setVisitedModes((prev) =>
        prev.has(host) ? prev : new Set([...prev, host])
      );
    });
  }, []);

  // The unified surface renders the host derived from the active mainPane tab.
  // Mark it visited synchronously so the keep-alive `<div>` for
  // browser/project mounts in the same commit and the 40px header strip never
  // flickers blank between tab clicks. Browser is a special case: the unified
  // "+" menu's "New Browser" entry bumps `workstationNewBrowserSessionRequestAtom`,
  // which only turns into a real session once `BrowserLayout` has mounted (it
  // owns the engine state). Pre-mount Browser (deferred, off the first-paint
  // path) so that action works even when no browser tab is active yet.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    queueVisit(activeHost, true);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    queueVisit("browser", false);
  }, [activeHost, queueVisit]);

  return { visitedModes };
}

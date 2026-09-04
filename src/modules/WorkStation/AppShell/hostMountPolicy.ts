/**
 * hostMountPolicy — pure predicates deciding which WorkStation content hosts
 * (code / browser / project / Agent Station simulator) are mounted at all.
 *
 * The AppShell keeps previously-visited hosts mounted-but-hidden so tab
 * switches stay instant. That keep-alive used to be monotonic: once a host
 * mounted it never unmounted, the code host was mounted from launch, and the
 * Browser host was unconditionally pre-mounted. These predicates bound the
 * keep-alive instead: with no real tabs there is nothing to keep warm, so
 * every host unmounts and the Launchpad owns the surface — releasing the
 * hidden subtrees (file tree, sidebars, simulator grid) and their idle
 * background work.
 *
 * The predicates are pure so the mount matrix is unit-testable; the atoms
 * feeding them live in `@src/store/workstation/tabHost`.
 */

/** Code / project hosts: mounted while active, or kept warm between real tabs. */
export function shouldMountWorkstationHost(options: {
  /** Any non-Launchpad tab in the main pane (`mainPaneHasRealTabsAtom`). */
  hasRealTabs: boolean;
  /** The active tab projects onto this host. */
  isActiveHost: boolean;
  /** The host was visited since the pool last emptied. */
  hasVisited: boolean;
}): boolean {
  const { hasRealTabs, isActiveHost, hasVisited } = options;
  return hasRealTabs && (isActiveHost || hasVisited);
}

/**
 * Browser host: the shared policy plus three extra mount triggers that
 * preserve its side-effect ownership without the old unconditional
 * pre-mount:
 *
 *  - `hasBrowserHostTabs` — background `browser-session` tabs need the
 *    host's sessions ↔ tab-strip sync running before first activation;
 *  - `hasBrowserSessions` — engine sessions (including ones restored from
 *    storage, or just created from a request) must keep their owner mounted
 *    until the tab sync catches up;
 *  - `hasPendingNewSessionRequest` — a "New Browser" click (Launchpad or the
 *    unified "+" menu) must mount the host so BrowserLayout's consumed-tick
 *    effect can turn the request into a live session.
 */
export function shouldMountBrowserHost(options: {
  hasRealTabs: boolean;
  isActiveHost: boolean;
  hasVisited: boolean;
  hasBrowserHostTabs: boolean;
  hasBrowserSessions: boolean;
  hasPendingNewSessionRequest: boolean;
}): boolean {
  const {
    hasRealTabs,
    isActiveHost,
    hasVisited,
    hasBrowserHostTabs,
    hasBrowserSessions,
    hasPendingNewSessionRequest,
  } = options;
  if (hasPendingNewSessionRequest || hasBrowserSessions) return true;
  return hasRealTabs && (isActiveHost || hasVisited || hasBrowserHostTabs);
}

/**
 * Agent Station simulator: mounted exactly when it is displayed.
 *
 * This host is the most expensive keep-alive in the app, so it gets no warm
 * window at all. The simulator grid mounts one full `ChatHistory` per cell —
 * its own virtualizer, projection pipeline, replay interval, and
 * `runtimeMemoryStats` entry — and the layout enum goes up to `3x4`, so a
 * hidden simulator can hold twelve of them. It previously stayed mounted
 * whenever a session was attached, which kept all of that alive for the entire
 * time the user was in the code editor or behind a maximized chat panel.
 *
 * Unmounting is safe because the simulator is a pure view: every event it
 * renders lives in the EventStore (kept warm by the snapshot cache's own LRU),
 * and it owns no subscription or interval that has to outlive its subtree. The
 * keep-alive was buying back a React tree rebuild from already-warm data, not
 * avoiding a refetch.
 *
 * `isChatPanelMaximized` is part of the condition rather than only
 * `isAgentStation` so that "mounted" and "displayed" cannot drift apart: a
 * maximized chat panel hides the simulator just as completely as leaving the
 * surface does. It is a deliberate layout mode, not focus/blur, so this does
 * not thrash.
 */
export function shouldMountAgentStationHost(options: {
  isAgentStation: boolean;
  isChatPanelMaximized: boolean;
}): boolean {
  const { isAgentStation, isChatPanelMaximized } = options;
  return isAgentStation && !isChatPanelMaximized;
}

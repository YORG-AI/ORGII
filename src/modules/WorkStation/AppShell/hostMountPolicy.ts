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
 * Agent Station simulator: always mounted while Agent Station is the visible
 * surface; kept warm while hidden only for as long as a session is attached,
 * so my-station ↔ agent-station toggles stay instant mid-session but an idle
 * simulator releases its subtree.
 */
export function shouldMountAgentStationHost(options: {
  isAgentStation: boolean;
  hasVisited: boolean;
  hasActiveSession: boolean;
}): boolean {
  const { isAgentStation, hasVisited, hasActiveSession } = options;
  return isAgentStation || (hasVisited && hasActiveSession);
}

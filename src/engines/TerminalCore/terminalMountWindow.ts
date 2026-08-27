/**
 * Terminal mount window policy.
 *
 * Only the active terminal plus the `MAX_WARM_INACTIVE_TERMINALS` most
 * recently active ones stay mounted. Everything else unmounts — releasing
 * its xterm instance (5000-line scrollback) and WebGL context — and remounts
 * on activation through the PTY attach/restore path in
 * `components/TerminalInteractive/terminalPty.ts` (`attach_pty_stream` snapshot plus the
 * serialized client buffer). Before this policy every initialized terminal,
 * including every one restored from localStorage at boot, stayed mounted
 * forever behind `display:none`.
 */
import { pushRecentId } from "@src/util/core/recentIdWindow";

/**
 * How many *inactive* terminals stay mounted (warm) in addition to the
 * active one.
 */
export const MAX_WARM_INACTIVE_TERMINALS = 4;

/**
 * Push `activeId` to the front of the most-recently-active list, bounded to
 * the active slot plus `maxWarm` inactive slots. Returns the same array
 * reference when nothing changes so React state updates stay no-ops.
 */
export function pushRecentTerminalId(
  prev: readonly string[],
  activeId: string,
  maxWarm: number = MAX_WARM_INACTIVE_TERMINALS
): readonly string[] {
  return pushRecentId(prev, activeId, maxWarm + 1);
}

/**
 * Select which sessions should be mounted: the active one always, plus
 * initialized sessions that are still inside the recent window.
 */
export function selectMountedTerminalSessions<T extends { id: string }>(
  sessions: readonly T[],
  activeSessionId: string,
  initializedSessionIds: ReadonlySet<string>,
  recentTerminalIds: readonly string[]
): T[] {
  const warm = new Set(recentTerminalIds);
  return sessions.filter(
    (session) =>
      session.id === activeSessionId ||
      (initializedSessionIds.has(session.id) && warm.has(session.id))
  );
}

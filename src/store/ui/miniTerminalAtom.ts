/**
 * Mini terminal docked under the Workstation trail.
 *
 * A short terminal panel that sits directly below the trail surface, in the
 * trail's own column and on its own surface. It does NOT own a terminal
 * runtime of its own: it *claims* Workstation PTY sessions out of
 * `store/workstation/codeEditor/terminal` and mounts them itself.
 *
 * # Why a claim rather than a second view
 *
 * A PTY session is bound to exactly one xterm instance through
 * `TerminalView`'s `sessionKey`. Mounting the same session twice would give
 * one PTY two writers and two competing `resize` calls, so a claimed session
 * is suppressed in the Workstation terminal pane (`TerminalCore`'s
 * `suppressedSessionIds`) for as long as the mini window holds it, and is
 * remounted there through the normal PTY attach/restore path once released.
 */
import { atom } from "jotai";

import type { AddSessionOptions } from "@src/engines/TerminalCore/types";
import { selectedRepoPathAtom } from "@src/store/repo";
import {
  activeTerminalIdAtom,
  closeTerminalSessionAtom,
  editorAddTerminalSessionAtom,
  terminalSessionsAtom,
} from "@src/store/workstation/codeEditor/terminal";

export const MINI_TERMINAL_SESSION_LIMIT = 3;

/** Panel shown. Suppression lifts whenever it hides. */
export const miniTerminalVisibleAtom = atom<boolean>(false);
miniTerminalVisibleAtom.debugLabel = "chatPanel/miniTerminal/visible";

/**
 * The trail is only mounted for a maximized session, so the panel that
 * mounts the claimed PTYs comes and goes with it. Suppression has to follow
 * that mount, or an unmounted trail would leave a claimed session with no
 * xterm anywhere. The host sets this from an effect; the panel mounts its
 * terminal only once suppression is actually in force, so the handover never
 * has a frame with two xterms on one PTY.
 */
export const miniTerminalHostMountedAtom = atom<boolean>(false);
miniTerminalHostMountedAtom.debugLabel = "chatPanel/miniTerminal/hostMounted";

const miniTerminalClaimedIdsStateAtom = atom<readonly string[]>([]);
miniTerminalClaimedIdsStateAtom.debugLabel =
  "chatPanel/miniTerminal/claimedIds/state";

/**
 * Workstation session ids the mini window currently mounts, pruned against
 * the live session list so a PTY killed elsewhere cannot strand a claim
 * that keeps suppressing a session id the store no longer has.
 */
export const miniTerminalClaimedIdsAtom = atom<readonly string[]>((get) => {
  const claimed = get(miniTerminalClaimedIdsStateAtom);
  if (claimed.length === 0) return claimed;
  const live = new Set(get(terminalSessionsAtom).map((session) => session.id));
  const pruned = claimed.filter((id) => live.has(id));
  return pruned.length === claimed.length ? claimed : pruned;
});
miniTerminalClaimedIdsAtom.debugLabel = "chatPanel/miniTerminal/claimedIds";

/**
 * Suppression set read by the Workstation terminal pane. Empty while the
 * panel is hidden or unmounted, so either one hands every session straight
 * back to the Workstation.
 */
export const miniTerminalSuppressedIdsAtom = atom<ReadonlySet<string>>(
  (get) =>
    new Set(
      get(miniTerminalVisibleAtom) && get(miniTerminalHostMountedAtom)
        ? get(miniTerminalClaimedIdsAtom)
        : []
    )
);
miniTerminalSuppressedIdsAtom.debugLabel =
  "chatPanel/miniTerminal/suppressedIds";

const miniTerminalActiveIdStateAtom = atom<string | null>(null);
miniTerminalActiveIdStateAtom.debugLabel =
  "chatPanel/miniTerminal/activeId/state";

/** Active tab inside the mini window, defaulted to the first live claim. */
export const miniTerminalActiveIdAtom = atom<string | null>((get) => {
  const claimed = get(miniTerminalClaimedIdsAtom);
  const active = get(miniTerminalActiveIdStateAtom);
  if (active && claimed.includes(active)) return active;
  return claimed[0] ?? null;
});
miniTerminalActiveIdAtom.debugLabel = "chatPanel/miniTerminal/activeId";

export const setMiniTerminalActiveIdAtom = atom(
  null,
  (_get, set, sessionId: string) => {
    set(miniTerminalActiveIdStateAtom, sessionId);
  }
);
setMiniTerminalActiveIdAtom.debugLabel = "chatPanel/miniTerminal/setActiveId";

/**
 * Show the panel on `sessionId`, or on a brand-new Workstation PTY when
 * called with `null`. Claiming an already-claimed session just focuses it.
 * Check capacity before creating anything so a full dock cannot leave an
 * extra Workstation session behind, including from stale UI callbacks.
 */
export const openMiniTerminalAtom = atom(
  null,
  (get, set, sessionId: string | null, options?: AddSessionOptions) => {
    const claimed = get(miniTerminalClaimedIdsAtom);
    if (
      claimed.length >= MINI_TERMINAL_SESSION_LIMIT &&
      (sessionId === null || !claimed.includes(sessionId))
    ) {
      return null;
    }
    const targetId =
      sessionId ??
      set(editorAddTerminalSessionAtom, {
        cwd: get(selectedRepoPathAtom) || undefined,
        ...options,
      });
    if (!targetId) return null;
    if (!claimed.includes(targetId)) {
      set(miniTerminalClaimedIdsStateAtom, [...claimed, targetId]);
    }
    set(miniTerminalActiveIdStateAtom, targetId);
    set(miniTerminalVisibleAtom, true);
    return targetId;
  }
);
openMiniTerminalAtom.debugLabel = "chatPanel/miniTerminal/open";

/**
 * Hand one session back to the Workstation pane. The panel closes once its
 * last claim is released, and the Workstation regains focus of the session
 * it had been showing.
 */
export const releaseMiniTerminalSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const remaining = get(miniTerminalClaimedIdsAtom).filter(
      (id) => id !== sessionId
    );
    set(miniTerminalClaimedIdsStateAtom, remaining);
    if (remaining.length === 0) {
      set(miniTerminalVisibleAtom, false);
      set(miniTerminalActiveIdStateAtom, null);
      return;
    }
    if (get(miniTerminalActiveIdStateAtom) === sessionId) {
      set(miniTerminalActiveIdStateAtom, remaining[0] ?? null);
    }
  }
);
releaseMiniTerminalSessionAtom.debugLabel = "chatPanel/miniTerminal/release";

/** Kill a claimed PTY outright (the panel's per-tab close control). */
export const closeMiniTerminalSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    set(releaseMiniTerminalSessionAtom, sessionId);
    void set(closeTerminalSessionAtom, sessionId);
  }
);
closeMiniTerminalSessionAtom.debugLabel = "chatPanel/miniTerminal/closeSession";

/**
 * Hide the panel and release every claim. The Workstation terminal pane
 * remounts the sessions it had been showing; the PTYs keep running.
 */
export const closeMiniTerminalAtom = atom(null, (get, set) => {
  // Read before clearing: the active id is derived from the claim list.
  const lastActive = get(miniTerminalActiveIdAtom);
  set(miniTerminalVisibleAtom, false);
  set(miniTerminalClaimedIdsStateAtom, []);
  set(miniTerminalActiveIdStateAtom, null);
  // Hand focus of the released session to the Workstation pane, so the tab
  // the user was just looking at is the one waiting for them there.
  if (lastActive && get(activeTerminalIdAtom) !== lastActive) {
    set(activeTerminalIdAtom, lastActive);
  }
});
closeMiniTerminalAtom.debugLabel = "chatPanel/miniTerminal/close";

/** Panel folded to just its header row; the PTY stays mounted behind it. */
export const miniTerminalCollapsedAtom = atom<boolean>(false);
miniTerminalCollapsedAtom.debugLabel = "chatPanel/miniTerminal/collapsed";

export const toggleMiniTerminalAtom = atom(null, (get, set) => {
  if (get(miniTerminalVisibleAtom)) {
    set(closeMiniTerminalAtom);
    return;
  }
  set(openMiniTerminalAtom, get(miniTerminalClaimedIdsAtom)[0] ?? null);
});
toggleMiniTerminalAtom.debugLabel = "chatPanel/miniTerminal/toggle";

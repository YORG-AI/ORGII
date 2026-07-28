/**
 * Sidebar State Atom
 *
 * Manages sidebar width and shared collapse state (localStorage).
 * Settings and session sidebars collapse and expand together.
 */
import { atom } from "jotai";

// ============================================
// Constants
// ============================================

export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 320;
export const COLLAPSED_SIDEBAR_WIDTH = 0;

// ============================================
// Shared collapsed persistence (localStorage)
// ============================================

const SIDEBAR_COLLAPSED_KEY = "orgii_sidebar_collapsed";

const getStoredCollapsed = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
};

const persistSidebarCollapsed = (collapsed: boolean): void => {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Ignore storage errors
  }
};

// ============================================
// Atoms
// ============================================

/** Global sidebar width (pixels) */
export const sidebarWidthAtom = atom<number>(DEFAULT_SIDEBAR_WIDTH);
sidebarWidthAtom.debugLabel = "sidebarWidthAtom";

const sidebarCollapsedBaseAtom = atom<boolean>(getStoredCollapsed());
sidebarCollapsedBaseAtom.debugLabel = "sidebarCollapsedBaseAtom";

/** Shared main sidebar collapsed state for Settings and session surfaces. */
export const sidebarCollapsedAtom = atom(
  (get) => get(sidebarCollapsedBaseAtom),
  (_get, set, value: boolean) => {
    set(sidebarCollapsedBaseAtom, value);
    persistSidebarCollapsed(value);
  }
);
sidebarCollapsedAtom.debugLabel = "sidebarCollapsedAtom";

/**
 * Sidebar dragging state atom
 */
export const sidebarDraggingAtom = atom<boolean>(false);
sidebarDraggingAtom.debugLabel = "sidebarDraggingAtom";

export interface SessionSidebarRevealTarget {
  /** Independently replayable session row that should be selected and shown. */
  sessionId: string;
  /** Root row to hydrate/expand when `sessionId` is a subagent transcript. */
  parentSessionId?: string;
  /**
   * Exact rendered menu item when the transcript is represented by another
   * surface (for example a `cloudremote-…` Team Session row).
   */
  sidebarItemId?: string;
  /** Cloud org whose Team Sessions section owns `sidebarItemId`. */
  cloudOrgId?: string;
  /**
   * Open the target instead of only revealing it. Set by in-app session
   * references, whose whole point is landing in the transcript; OS deep
   * links stay reveal-only so an external click never starts a download.
   */
  autoReplay?: boolean;
}

export interface SessionSidebarRevealRequest extends SessionSidebarRevealTarget {
  requestId: number;
  /**
   * Epoch ms the request was published. Nothing clears a reveal aimed at a
   * cloud row (its local id never matches the requested one), so an
   * `autoReplay` request that could not be served stays resident; consumers
   * use this to stop honouring one long after the click that made it.
   */
  issuedAt: number;
}

/**
 * Ephemeral navigation intent for cross-surface session links.
 *
 * The connector remains the sole owner of sidebar filters, collapsed groups,
 * and subagent expansion. Callers publish only the target identity here so a
 * Session Blame link does not need to duplicate sidebar grouping logic.
 */
export const sessionSidebarRevealRequestAtom =
  atom<SessionSidebarRevealRequest | null>(null);
sessionSidebarRevealRequestAtom.debugLabel = "sessionSidebarRevealRequestAtom";
const sessionSidebarRevealRequestIdAtom = atom(0);

export const requestSessionSidebarRevealAtom = atom(
  null,
  (get, set, target: SessionSidebarRevealTarget) => {
    const sessionId = target.sessionId.trim();
    const parentSessionId = target.parentSessionId?.trim() || undefined;
    const sidebarItemId = target.sidebarItemId?.trim() || undefined;
    const cloudOrgId = target.cloudOrgId?.trim() || undefined;
    if (!sessionId) return;
    const requestId = get(sessionSidebarRevealRequestIdAtom) + 1;
    set(sessionSidebarRevealRequestIdAtom, requestId);
    set(sessionSidebarRevealRequestAtom, {
      sessionId,
      parentSessionId,
      ...(sidebarItemId ? { sidebarItemId } : {}),
      ...(cloudOrgId ? { cloudOrgId } : {}),
      ...(target.autoReplay ? { autoReplay: true } : {}),
      requestId,
      issuedAt: Date.now(),
    });
  }
);
requestSessionSidebarRevealAtom.debugLabel = "requestSessionSidebarRevealAtom";

/** Clear one completed reveal without racing a newer navigation request. */
export const clearSessionSidebarRevealAtom = atom(
  null,
  (get, set, requestId: number) => {
    if (get(sessionSidebarRevealRequestAtom)?.requestId === requestId) {
      set(sessionSidebarRevealRequestAtom, null);
    }
  }
);
clearSessionSidebarRevealAtom.debugLabel = "clearSessionSidebarRevealAtom";

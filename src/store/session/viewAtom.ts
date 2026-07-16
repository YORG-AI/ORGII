/**
 * Session View Atom
 *
 * # Two-atom session selection model
 *
 * The app has two distinct notions of "active session":
 *
 *   1. `workstationActiveSessionIdAtom` — the WorkStation's *remembered*
 *      selection. Persisted in `sessionViewAtom`. Reset to null on hard
 *      reload (per "startup must be inert" rule). Written by every
 *      navigation/launch site that opens a session in WorkStation.
 *      What WorkStation will show next time it becomes visible.
 *
 *   2. `activeSessionIdAtom` — the *pipeline* session. Transient
 *      (in-memory only). Read by `SessionSyncProvider` and by every
 *      chat-rendering component. What the singleton event store is
 *      currently subscribed to.
 *
 * For most paths the two atoms hold the same value: WorkStation owners
 * write both, and a bridge effect in the AppShell mirrors workstation
 * → pipeline whenever WorkStation becomes visible. They diverge during
 * secondary surfaces (kanban detail panel, future inbox/etc.) where a
 * `<ChatView>` writes the pipeline atom alone — letting that surface
 * inspect another session's chat without permanently switching what
 * WorkStation will show.
 *
 * `jumpToSessionAtom` remains the canonical "navigate to a session"
 * action — it writes both atoms and runs the clear → loading → set-id
 * sequence.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import { clearSessionAtom } from "@src/engines/SessionCore/core/atoms/actions";
import {
  loadStatusAtom,
  sessionIdAtom,
  triggerSessionReloadAtom,
} from "@src/engines/SessionCore/core/atoms/metadata";
import {
  registerLiveSubagentSignalAtom,
  registerRuntimeStatusGateSessionAtoms,
} from "@src/store/session/cliSessionStatusAtom";
import {
  hasLiveSubagentJobs,
  subagentJobMapAtom,
} from "@src/store/session/subagentJobAtom";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import type { SessionViewState } from "./types";
import { markSessionVisited } from "./visitedSessionsAtom";

// ============================================
// Storage Keys
// ============================================

const STORAGE_KEY = "orgii-v2-session-view";

// ============================================
// Default State
// ============================================

const DEFAULT_STATE: SessionViewState = {
  activeSessionId: null,
  sessionName: undefined,
  repoPath: undefined,
};

const SessionViewStateStorageSchema = z
  .object({
    activeSessionId: z.string().nullable().optional(),
    sessionName: z.string().optional(),
    repoPath: z.string().optional(),
  })
  .transform(
    (value): SessionViewState => ({
      ...value,
      activeSessionId: null,
    })
  );

// ============================================
// Main Atom
// ============================================

/**
 * Session view state - persisted
 *
 * activeSessionId is NOT restored across app restarts — startup must be
 * inert (no session work until the user explicitly acts). Only metadata
 * (sessionName, repoPath) survives a reload.
 */
export const sessionViewAtom = atomWithStorage<SessionViewState>(
  STORAGE_KEY,
  DEFAULT_STATE,
  createZodJsonStorage(SessionViewStateStorageSchema),
  { getOnInit: true }
);
sessionViewAtom.debugLabel = "sessionViewAtom";

// ============================================
// Derived / Pipeline Atoms
// ============================================

/**
 * WorkStation's remembered session selection. Persisted via
 * `sessionViewAtom` (with the same null-on-reload filter).
 *
 * Writers: every path that opens a session "into WorkStation" —
 * `useSessionLaunch`, `useAppNavigation`, `SessionService.openSession`,
 * `nav.openSession`, `jumpToSessionAtom`, the empty-cache reload in
 * `ChatHistory`. These sites typically also
 * write `activeSessionIdAtom` (the pipeline) so the chat updates
 * immediately when WorkStation is the visible surface.
 */
export const workstationActiveSessionIdAtom = atom(
  (get) => get(sessionViewAtom).activeSessionId,
  (get, set, sessionId: string | null) => {
    const current = get(sessionViewAtom);
    if (current.activeSessionId === sessionId) return;
    set(sessionViewAtom, { ...current, activeSessionId: sessionId });
  }
);
workstationActiveSessionIdAtom.debugLabel = "workstationActiveSessionIdAtom";

/**
 * Pipeline session id — what `SessionSyncProvider` (and via it, every
 * chat-rendering component) follows. Transient: not persisted.
 *
 * Writers:
 *  - WorkStation owners (alongside writing
 *    `workstationActiveSessionIdAtom`).
 *  - The AppShell bridge effect that mirrors workstation → pipeline
 *    when WorkStation becomes visible (so the user finds their last
 *    session even if a secondary surface wrote pipeline in the
 *    meantime).
 *  - `<ChatView>` mount effect — claims the pipeline for the session
 *    it was given. This is how kanban detail panels, etc. show a
 *    session's chat without disturbing WorkStation's memory.
 */
export const activeSessionIdAtom = atom<string | null>(null);
activeSessionIdAtom.debugLabel = "activeSessionIdAtom";

// Runtime-status writes are gated to the visible session. Both "visible"
// atoms qualify: the pipeline id (what the chat surface renders) and the
// SessionCore sessionIdAtom (what the event store is subscribed to) — they
// briefly diverge during session switches, and a write matching either one
// is for a session the user can see. Registered here (not imported by the
// status atom module) to avoid an import cycle through SessionCore actions.
registerRuntimeStatusGateSessionAtoms([activeSessionIdAtom, sessionIdAtom]);

// Live-subagent signal for `isSessionActiveAtom`: true when the pipeline
// session (what the composer + planning footer read) has a still-running
// background subagent. Registered here — not imported by the status atom
// module — because reading `sessionIdAtom` there would create an import
// cycle through SessionCore actions (same reason as the gate atoms above).
const liveSubagentSignalAtom = atom<boolean>((get) =>
  hasLiveSubagentJobs(get(subagentJobMapAtom), get(sessionIdAtom))
);
liveSubagentSignalAtom.debugLabel = "liveSubagentSignal";
registerLiveSubagentSignalAtom(liveSubagentSignalAtom);

/**
 * Is a session currently active?
 */
export const hasActiveSessionAtom = atom(
  (get) => get(sessionViewAtom).activeSessionId !== null
);
hasActiveSessionAtom.debugLabel = "hasActiveSessionAtom";

// ============================================
// Action Atoms
// ============================================

/**
 * Open a session — writes both the WorkStation memory and the pipeline.
 */
export const openSessionAtom = atom(
  null,
  (
    _get,
    set,
    payload: { sessionId: string; sessionName?: string; repoPath?: string }
  ) => {
    set(sessionViewAtom, {
      activeSessionId: payload.sessionId,
      sessionName: payload.sessionName,
      repoPath: payload.repoPath,
    });
    set(activeSessionIdAtom, payload.sessionId);
  }
);
openSessionAtom.debugLabel = "openSessionAtom";

/**
 * Close current session — clears both memory and pipeline.
 */
export const closeSessionAtom = atom(null, (_get, set) => {
  set(sessionViewAtom, {
    activeSessionId: null,
    sessionName: undefined,
    repoPath: undefined,
  });
  set(activeSessionIdAtom, null);
});
closeSessionAtom.debugLabel = "closeSessionAtom";

/**
 * Update session metadata (name, repoPath)
 */
export const updateSessionMetadataAtom = atom(
  null,
  (get, set, updates: { sessionName?: string; repoPath?: string }) => {
    const current = get(sessionViewAtom);
    set(sessionViewAtom, { ...current, ...updates });
  }
);
updateSessionMetadataAtom.debugLabel = "updateSessionMetadataAtom";

// ============================================
// Canonical Session Jump Action
// ============================================

/**
 * Unified action for switching sessions. Every navigation path
 * (sidebar, history panel, Chat tool tabs, control tower) MUST
 * use this atom to avoid state leaks and timestamp jumps.
 *
 * Sequence: clear old state → set loading → set workstation memory →
 * set pipeline → optionally update sessionName/repoPath → mark visited.
 *
 * Callers that also manage tabs or route navigation do so *around*
 * this atom — the atom only owns the session-engine state transition.
 */
/**
 * Payload accepts either a bare session ID (legacy) or a richer
 * object with optional `sessionName` / `repoPath` so callers can
 * jump and update view metadata in a single atom write — avoiding
 * the prior "two writes to sessionViewAtom in a row" pattern that
 * fired duplicate localStorage flushes per sidebar click.
 */
export type JumpToSessionPayload =
  | string
  | null
  | { sessionId: string | null; sessionName?: string; repoPath?: string };

export const jumpToSessionAtom = atom(
  null,
  (get, set, payload: JumpToSessionPayload) => {
    const isRich = payload !== null && typeof payload === "object";
    const sessionId = isRich ? payload.sessionId : payload;
    const previousPipelineSessionId = get(activeSessionIdAtom);

    set(clearSessionAtom);
    set(loadStatusAtom, sessionId ? "loading" : "idle");
    // WorkStation owns the navigation, so update its memory atom AND
    // the pipeline atom in a single underlying-storage write. When
    // the caller passes the rich form with name/repoPath, fold those
    // in to avoid the prior jump-then-update double-flush; otherwise
    // preserve whatever metadata was already there.
    const current = get(sessionViewAtom);
    set(sessionViewAtom, {
      activeSessionId: sessionId,
      sessionName: isRich ? payload.sessionName : current.sessionName,
      repoPath: isRich ? payload.repoPath : current.repoPath,
    });
    set(activeSessionIdAtom, sessionId);
    if (sessionId && previousPipelineSessionId === sessionId) {
      set(triggerSessionReloadAtom, sessionId);
    }
    if (sessionId) {
      // Clear "unread" badge: the user has now opened this session.
      markSessionVisited(sessionId);
    }
  }
);
jumpToSessionAtom.debugLabel = "jumpToSessionAtom";

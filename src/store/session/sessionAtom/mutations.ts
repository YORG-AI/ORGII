/**
 * Session Mutations
 *
 * Functions that modify the session store (add, update, remove, reset).
 *
 * ## Timestamp policy
 *
 * `Session.created_at` and `Session.updated_at` are backend-owned. The
 * frontend MUST NOT synthesize them as a side-effect of *reads*. They
 * flow into the store via exactly three paths:
 *
 *   1. `loadSessions()` — full list replace from `session_aggregate_list`
 *      (and the supplementary Cursor IDE row read).
 *   2. Insert path of `upsertSession()` — for a brand-new session,
 *      whose timestamps still originate from the launch RPC response.
 *   3. `markSessionActive()` — explicitly bumped on a real *user
 *      action* (currently only "send a prompt"). This is NOT a
 *      reconcile-driven write; it represents activity the user just
 *      performed, so it's the correct signal for sidebar / Kanban
 *      "recent activity" ordering.
 *
 * On the *update* path of `upsertSession()` we deliberately preserve
 * the prior record's timestamps and ignore whatever the caller spread
 * in. This protects views that key off "recent activity" (Kanban time
 * filter, sidebar ordering) from being polluted by local reconciles —
 * e.g. opening a multi-day-old session in WorkStation must NOT make
 * it surface in the 6h Kanban window. `markSessionActive()` is the
 * intentional escape hatch for "the user just did something, bump
 * the row".
 */
import { disposeSessionStreamingState } from "@src/engines/SessionCore/sync/adapters/rustAgent/eventHandlers/streamHelpers";
import { cursorIdeTurnSummariesAtomFamily } from "@src/store/session/cursorIdeTurnSummariesAtom";
import { tuiModeAtom } from "@src/store/session/tuiModeAtom";
import { clearTodosForSessionAtom } from "@src/store/ui/todoAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  sessionFlatListLastLoadedBySignatureAtom,
  sessionLastLoadedAtom,
  sessionsAtom,
} from "./atoms";
import { removeGuestImportedSession } from "./guestImportRegistry";
import type { Session, SessionStatus } from "./types";

const getStore = () => getInstrumentedStore();

/**
 * Add or update a session in the store.
 *
 * - Insert: stores the record verbatim. Callers minting a new session
 *   are expected to source `created_at` / `updated_at` from the
 *   backend launch response.
 * - Update: shallow-merges `incoming` over the prior record but
 *   **always preserves** the prior `created_at` / `updated_at`.
 *   See the file-level "Timestamp policy" doc.
 */
export const upsertSession = (session: Session) => {
  const store = getStore();
  store.set(sessionsAtom, (prev) => {
    const existingIndex = prev.findIndex(
      (existingSession) => existingSession.session_id === session.session_id
    );

    if (existingIndex >= 0) {
      const existing = prev[existingIndex];
      const updated = [...prev];
      updated[existingIndex] = {
        ...existing,
        ...session,
        parentSessionId: session.parentSessionId ?? existing.parentSessionId,
        orgMemberId: session.orgMemberId ?? existing.orgMemberId,
        agentOrgId: session.agentOrgId ?? existing.agentOrgId,
        agentOrgName: session.agentOrgName ?? existing.agentOrgName,
        agentDefinitionId:
          session.agentDefinitionId ?? existing.agentDefinitionId,
        agentIconId: session.agentIconId ?? existing.agentIconId,
        agentDisplayName: session.agentDisplayName ?? existing.agentDisplayName,
        // Backend-owned. Pin to the prior values so a careless caller
        // spreading a synthesized timestamp can't drift the field.
        // `*_time` are aliases populated alongside `*_at` from the
        // same RPC fields — kept in lockstep for the same reason.
        created_at: existing.created_at,
        updated_at: existing.updated_at,
        created_time: existing.created_time,
        updated_time: existing.updated_time,
      };
      return updated;
    } else {
      const newList = [session, ...prev];
      return newList;
    }
  });
};

/**
 * Bump a session's activity timestamps to "now".
 *
 * Called when the user performs a real action against the session
 * (currently only sending a prompt — see `SessionService.sendMessage`).
 * Updates `updated_at` / `updated_time` so views ordered by "recent
 * activity" (sidebar, Kanban) reflect the action immediately, without
 * waiting for the next session list refresh.
 *
 * Intentionally separate from `upsertSession` so reconcile-driven
 * paths can't reach this mutation by accident — see the file-level
 * "Timestamp policy" doc.
 *
 * No-op if the session isn't in the store yet (e.g. send fired before
 * the launch RPC response landed; the next list refresh will pick up
 * the backend timestamp anyway).
 */
export const markSessionActive = (sessionId: string) => {
  const store = getStore();
  const now = new Date().toISOString();
  store.set(sessionsAtom, (prev) =>
    prev.map((session) =>
      session.session_id === sessionId
        ? { ...session, updated_at: now, updated_time: now }
        : session
    )
  );
};

/**
 * Remove a session from the store.
 */
export const removeSession = (sessionId: string) => {
  const store = getStore();
  store.set(sessionsAtom, (prev) =>
    prev.filter((session) => session.session_id !== sessionId)
  );
  // A removed session has no live viewers, so free its per-session caches.
  // Without this they accumulate one entry per session for the app lifetime —
  // and tuiMode additionally leaves a `orgii:tuiMode:<id>` localStorage key.
  cursorIdeTurnSummariesAtomFamily.remove(sessionId);
  tuiModeAtom.remove(sessionId);
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(`orgii:tuiMode:${sessionId}`);
  }
  store.set(clearTodosForSessionAtom, sessionId);
  removeGuestImportedSession(sessionId);
  // Rust-agent streaming-stop state (per-turn stop markers etc.). This single
  // chokepoint covers every removal path — sidebar delete, cloud remove, fork
  // rollback, guest-share remove — so callers need not dispose it themselves.
  disposeSessionStreamingState(sessionId);
};

/**
 * Update a session's `status` in the local list cache.
 *
 * Only the status field is patched. We deliberately do NOT touch
 * `updated_at` here: that field is the backend's authoritative
 * "last meaningful activity" timestamp and is consumed by views that
 * decide what is "recent" — most notably the Kanban time-filter
 * window (6h / 12h / 24h / …) and the sidebar's pre-sorted ordering.
 * Stamping `Date.now()` whenever a local viewer happens to reconcile
 * status would make a multi-day-old session re-surface in the 6h
 * board the moment it is opened in WorkStation, which is wrong.
 *
 * If the status flip should also bump activity time, the backend
 * will emit a fresh `updated_at` on the next session list refresh.
 */
export const updateSessionStatus = (
  sessionId: string,
  status: SessionStatus
) => {
  const store = getStore();
  store.set(sessionsAtom, (prev) => {
    // Short-circuit when the row already carries this status. Live-status
    // pushes fire many times per second per running agent; without this guard
    // every heartbeat allocated a fresh length-n array and invalidated the
    // whole sidebar derivation cascade even when nothing changed.
    let changed = false;
    const next = prev.map((session) => {
      if (session.session_id === sessionId && session.status !== status) {
        changed = true;
        return { ...session, status };
      }
      return session;
    });
    return changed ? next : prev;
  });
};

/**
 * Invalidate cache and force refresh
 */
export const resetSessionStore = () => {
  const store = getStore();
  store.set(sessionLastLoadedAtom, null);
  store.set(sessionFlatListLastLoadedBySignatureAtom, {});
};

/**
 * Clear all sessions (use with caution)
 */
export const clearSessions = () => {
  const store = getStore();
  store.set(sessionsAtom, []);
  store.set(sessionLastLoadedAtom, null);
  store.set(sessionFlatListLastLoadedBySignatureAtom, {});
};

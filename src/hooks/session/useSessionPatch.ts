/**
 * useSessionPatch
 *
 * In-session field mutation hook.
 *
 * Per-session input state (model, account, exec mode) lives in the
 * Rust `agent_sessions` / `code_sessions` tables — see
 * `docs/session/per-session-input-state-audit-and-plan--0430.md`.
 * UI components that let the user edit those fields (`ModelPalette`,
 * `ModePill`) call into this hook so:
 *
 *  1. The optimistic update happens immediately (`upsertSession`).
 *  2. The Rust patch lands in the background.
 *  3. On error, the optimistic write is rolled back to the previous
 *     value and the error is surfaced (toast left to the caller —
 *     pill UIs already render error states).
 *
 * Two narrow surfaces deliberately wrap the same `rpc.sessionAggregate.patch`
 * call rather than exposing the raw `SessionPatch` shape:
 *
 *  - `useSessionModelField` — atomic `(model, accountId)` swap. Most
 *    callers know both at once because the model picker resolves the
 *    backing key.
 *  - `useSessionExecModeField` — single `agentExecMode` write. Only
 *    legal for Rust-agent sessions; CLI sessions don't render a
 *    ModePill so they never reach here.
 *
 * Both share `usePatchSession` for the optimistic + rollback machinery
 * so future fields (drafts in P3) only need a thin wrapper.
 */
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";
import {
  type Session,
  sessionByIdAtom,
  upsertSession,
} from "@src/store/session";

interface PatchOptions {
  name?: string;
  model?: string;
  accountId?: string;
  agentExecMode?: string;
  /**
   * Three-state per-session draft text (P3):
   *   undefined → leave column alone
   *   null      → clear the draft (composer was emptied / message sent)
   *   string    → set the draft to this value
   * Mirrors the Rust `Option<Option<String>>` deserialize on
   * `SessionPatch::draft_text`.
   */
  draftText?: string | null;
  /** Three-state reply target event id (P3). Same semantics as `draftText`. */
  replyTargetEventId?: string | null;
  /** Pin toggle (P5). Absent = leave alone. */
  pinned?: boolean;
}

interface PatchState {
  isPatching: boolean;
  error: string | null;
}

function normalizedOptionalText(
  value: string | null | undefined
): string | undefined {
  return value == null || value === "" ? undefined : value;
}

function patchWouldChangeSession(
  before: Session,
  options: PatchOptions
): boolean {
  if (options.name !== undefined && before.name !== options.name) return true;
  if (options.model !== undefined && before.model !== options.model)
    return true;
  if (options.accountId !== undefined && before.accountId !== options.accountId)
    return true;
  if (
    options.agentExecMode !== undefined &&
    before.agentExecMode !== options.agentExecMode
  )
    return true;
  if (
    options.draftText !== undefined &&
    before.draftText !== normalizedOptionalText(options.draftText)
  )
    return true;
  if (
    options.replyTargetEventId !== undefined &&
    before.replyTargetEventId !==
      normalizedOptionalText(options.replyTargetEventId)
  )
    return true;
  if (options.pinned !== undefined && before.pinned !== options.pinned)
    return true;
  return false;
}

/**
 * Low-level patch primitive: optimistic write → RPC → rollback on error.
 *
 * Returns a stable function `(sessionId, patch) => Promise<void>` plus
 * the in-flight / error state for the most recent call.
 */
function usePatchSession(): {
  patch: (sessionId: string, patch: PatchOptions) => Promise<void>;
} & PatchState {
  const [state, setState] = useState<PatchState>({
    isPatching: false,
    error: null,
  });

  const patch = useCallback(
    async (sessionId: string, options: PatchOptions): Promise<void> => {
      setState({ isPatching: true, error: null });
      // Snapshot the prior values BEFORE the optimistic write so we
      // can restore them on error. Reading via the instrumented store
      // avoids a stale-closure issue if the same hook instance fires
      // back-to-back patches for the same session.
      const { getInstrumentedStore } =
        await import("@src/util/core/state/instrumentedStore");
      const store = getInstrumentedStore();
      const before = store.get(sessionByIdAtom(sessionId)) as
        | Session
        | undefined;

      if (!before) {
        // Session not in the local store — bail out before we send a
        // patch the backend would just reject with "not found". This
        // typically means the session was deleted while the user had
        // a stale pill open.
        const message = `useSessionPatch: session ${sessionId} not in local store`;
        setState({ isPatching: false, error: message });
        throw new Error(message);
      }

      if (!patchWouldChangeSession(before, options)) {
        setState({ isPatching: false, error: null });
        return;
      }

      const optimistic: Session = { ...before };
      if (options.name !== undefined) optimistic.name = options.name;
      if (options.model !== undefined) optimistic.model = options.model;
      if (options.accountId !== undefined)
        optimistic.accountId = options.accountId;
      if (options.agentExecMode !== undefined)
        optimistic.agentExecMode = options.agentExecMode;
      // Three-state fields: `null` clears (write `undefined` into the
      // optimistic session, since the Session type uses `undefined` for
      // "no value"); a string sets; a property left absent on `options`
      // means "don't touch it".
      if (options.draftText !== undefined)
        optimistic.draftText = options.draftText ?? undefined;
      if (options.replyTargetEventId !== undefined)
        optimistic.replyTargetEventId = options.replyTargetEventId ?? undefined;
      if (options.pinned !== undefined) optimistic.pinned = options.pinned;
      upsertSession(optimistic);

      // Imported teammate copies (`Session.importedFrom`) exist ONLY in the
      // TS store — there is no agent_sessions/code_sessions row for the
      // backend to patch, so the RPC would reject with "session not found"
      // (surfacing as a full-screen App error from e.g. the composer's
      // debounced draft save or the model picker). The optimistic local
      // write above IS the persistence these rows get; skip the RPC.
      if (before.importedFrom) {
        setState({ isPatching: false, error: null });
        return;
      }

      try {
        await rpc.sessionAggregate.patch({
          sessionId,
          patch: {
            name: options.name,
            model: options.model,
            accountId: options.accountId,
            agentExecMode: options.agentExecMode,
            // Forward the tri-state values verbatim. zod's
            // `.nullable().optional()` lines up with the Rust double-
            // Option deserialize: undefined skips, null clears, string
            // sets.
            draftText: options.draftText,
            replyTargetEventId: options.replyTargetEventId,
            pinned: options.pinned,
          },
        });
        setState({ isPatching: false, error: null });
      } catch (err) {
        // Roll back to the snapshot taken above. We re-write the full
        // prior session record (not just the touched fields) so a
        // partial backend success — which the Rust handler currently
        // can't produce, but a future split write could — wouldn't
        // leave the UI in a hybrid state.
        upsertSession(before);
        const message =
          err instanceof Error ? err.message : String(err ?? "patch failed");
        setState({ isPatching: false, error: message });
        throw err;
      }
    },
    []
  );

  return { patch, ...state };
}

/**
 * Read+write the per-session display title.
 */
export function useSessionNameField(sessionId: string) {
  const session = useAtomValue(sessionByIdAtom(sessionId));
  const { patch, isPatching, error } = usePatchSession();

  const setName = useCallback(
    (name: string) => patch(sessionId, { name }),
    [patch, sessionId]
  );

  return {
    name: session?.name,
    setName,
    isPatching,
    error,
  };
}

/**
 * Read+write the per-session model/account pair.
 *
 * Returns the current values (from `sessionByIdAtom`) plus a
 * `setModel` function that performs an atomic backend patch.
 *
 * Pass `accountId: null` to leave it unchanged when only the model
 * name changes (e.g. switching between two Anthropic models on the
 * same key).
 */
export function useSessionModelField(sessionId: string) {
  const session = useAtomValue(sessionByIdAtom(sessionId));
  const { patch, isPatching, error } = usePatchSession();

  const setModel = useCallback(
    (model: string, accountId?: string) =>
      patch(sessionId, { model, accountId }),
    [patch, sessionId]
  );

  return {
    model: session?.model,
    accountId: session?.accountId,
    setModel,
    isPatching,
    error,
  };
}

/**
 * Read+write the per-session exec mode.
 *
 * Returns the current value (or `undefined` if the user has never
 * patched this session — UI should fall back to
 * `creatorDefaultExecModeAtom` in that case) plus a `setMode`
 * function that performs the backend patch.
 *
 * The Rust side rejects this for CLI sessions, so the caller is
 * responsible for not rendering a ModePill on CLI sessions.
 */
export function useSessionExecModeField(sessionId: string) {
  const session = useAtomValue(sessionByIdAtom(sessionId));
  const { patch, isPatching, error } = usePatchSession();

  const setMode = useCallback(
    (mode: string) => patch(sessionId, { agentExecMode: mode }),
    [patch, sessionId]
  );

  return {
    agentExecMode: session?.agentExecMode,
    setMode,
    isPatching,
    error,
  };
}

/** Default debounce window for draft writes. Each keystroke schedules a
 *  patch; new keystrokes within this window cancel the prior schedule.
 *  300ms strikes a balance between "feels instant on paste / send" and
 *  "doesn't hammer SQLite on every keystroke". Tunable per-call via
 *  the `debounceMs` argument to `useSessionDraftField`. */
const DEFAULT_DRAFT_DEBOUNCE_MS = 300;

/**
 * Read+write the per-session draft text (P3).
 *
 * The chat composer stores the user's unsent text on the session row so
 * it survives navigation, app restarts, and background row refreshes
 * (the upsert path explicitly preserves `draft_text` — see
 * `UPSERT_SESSION_SQL`). This hook gives the composer:
 *
 *  - `draftText` — the persisted value to seed the editor with on mount
 *    or session switch.
 *  - `setDraft(text)` — debounced write; pass `""` to clear.
 *  - `flushDraft(text)` — immediate write; the composer calls this on
 *    `send` so the queued message can clear the draft synchronously
 *    instead of racing the debounce timer.
 *
 * Empty string is treated as "clear" — the Rust helper normalizes it to
 * SQL NULL, and on the wire we send `null` so the column is cleared
 * rather than left with an empty string nobody intends to read back.
 *
 * NOT to be confused with `sessionCreatorDraftAtom`
 * (`src/store/session/creatorDraftAtom.ts`): that is the
 * **pre-launch** SessionCreator's localStorage-backed single draft
 * slot for composing a *new* session. This hook covers **post-launch**
 * per-existing-session ChatPanel composer state. The two never share
 * the same logical message — the SessionCreator draft is consumed
 * (sent as the first user_message) and cleared at launch time.
 */
export function useSessionDraftField(
  sessionId: string,
  debounceMs: number = DEFAULT_DRAFT_DEBOUNCE_MS
) {
  const session = useAtomValue(sessionByIdAtom(sessionId));
  const { patch, isPatching, error } = usePatchSession();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the most recently-scheduled value so the timer callback writes
  // the freshest text, not a stale closure capture.
  const pendingRef = useRef<string | null>(null);

  // Cancel any pending write when the session id changes — a draft
  // queued for session A should not race a session-switch into session
  // B and overwrite the wrong row.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
    };
  }, [sessionId]);

  const flushDraft = useCallback(
    (text: string) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
      // Empty string → null on the wire so SQLite stores NULL (matches
      // the Rust `update_draft_text` empty-string normalization).
      const wire = text === "" ? null : text;
      return patch(sessionId, { draftText: wire });
    },
    [patch, sessionId]
  );

  const setDraft = useCallback(
    (text: string) => {
      pendingRef.current = text;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const value = pendingRef.current;
        pendingRef.current = null;
        if (value === null) return;
        const wire = value === "" ? null : value;
        // Fire and forget — errors are tracked via `error` state and
        // the optimistic update has already taken effect. We do not
        // surface a draft-write rejection to the user since the next
        // keystroke will retry.
        void patch(sessionId, { draftText: wire }).catch(() => {});
      }, debounceMs);
    },
    [debounceMs, patch, sessionId]
  );

  return {
    draftText: session?.draftText,
    setDraft,
    flushDraft,
    isPatching,
    error,
  };
}

/**
 * Read+write the per-session reply target event id (P3).
 *
 * The chat composer pins a reply target when the user clicks "Reply"
 * on a chat item, and clears it when the banner is dismissed or the
 * follow-up message is sent. Persisting it on the session row means
 * the banner survives navigation, app restarts, and background row
 * refreshes — same posture as `draftText`.
 *
 */
export function useSessionReplyField(sessionId: string) {
  const session = useAtomValue(sessionByIdAtom(sessionId));
  const { patch, isPatching, error } = usePatchSession();

  const setReplyTarget = useCallback(
    (eventId: string | null) =>
      patch(sessionId, { replyTargetEventId: eventId }),
    [patch, sessionId]
  );

  const clearReplyTarget = useCallback(
    () => patch(sessionId, { replyTargetEventId: null }),
    [patch, sessionId]
  );

  return {
    replyTargetEventId: session?.replyTargetEventId,
    setReplyTarget,
    clearReplyTarget,
    isPatching,
    error,
  };
}
/**
 * Read+write the per-session pinned state (P5).
 *
 * Pinned sessions appear at the top of the sidebar in all group-by modes.
 * Only legal for agent sessions.
 */
export function useSessionPinned(sessionId: string) {
  const session = useAtomValue(sessionByIdAtom(sessionId));
  const { patch, isPatching, error } = usePatchSession();

  const setPinned = useCallback(
    (pinned: boolean) => patch(sessionId, { pinned }),
    [patch, sessionId]
  );

  const togglePinned = useCallback(
    () => patch(sessionId, { pinned: !(session?.pinned ?? false) }),
    [patch, session, sessionId]
  );

  return {
    pinned: session?.pinned ?? false,
    setPinned,
    togglePinned,
    isPatching,
    error,
  };
}

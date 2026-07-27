/**
 * Session Runtime Atoms
 *
 * Tracks the UI-effective session run status for all session types.
 *
 * Rust `status_changed` events are authoritative once they arrive, but dispatch
 * paths may set optimistic `running`/`idle` values before the first event so the
 * composer, Stop button, and queue UX react immediately.
 */
import { type Atom, atom } from "jotai";

import type { CliSessionStatus } from "@src/types/session/session";

// Single source of truth: @src/types/session/session
export type { CliSessionStatus } from "@src/types/session/session";

// ============================================
// Core Session Runtime Atoms
// ============================================

/** UI-effective session run status; Rust events overwrite optimistic values. */
export const sessionRuntimeStatusAtom = atom<CliSessionStatus>("idle");
sessionRuntimeStatusAtom.debugLabel = "sessionRuntimeStatus";

export type SessionRuntimeStatusSource =
  | "dispatch"
  | "queue"
  | "sync"
  | "timeline-boundary"
  | "planning"
  | "launch"
  | "interactive-event"
  | "repo-setup"
  | "session-reset"
  | "e2e";

/**
 * Session-scope gate for runtime-status writes.
 *
 * `sessionRuntimeStatusAtom` is a single global value that mirrors the
 * status of the session the user is currently looking at. Historically any
 * writer could overwrite it regardless of which session it was acting on,
 * which caused cross-session bleed (e.g. a force-send boundary on a
 * background session wiping the foreground session's planning footer —
 * `useQuestionBatches` documents the same bleed class).
 *
 * The gate atoms identify "the visible session": a write is applied only
 * when its `sessionId` matches at least one of them. They are registered by
 * `viewAtom.ts` at module load (activeSessionIdAtom + the SessionCore
 * pipeline sessionIdAtom) instead of being imported here, because importing
 * viewAtom from this module would create an import cycle
 * (viewAtom → SessionCore actions → actionsUtils → this file).
 *
 * Before registration (tests, very early startup) the gate fails open so
 * behavior degrades to the historical global write. It also fails open in the
 * cold-start window where all gate atoms are still null (no visible session
 * established yet), so an optimistic running write dispatched immediately after
 * a reload or session switch is not silently dropped.
 */
let runtimeStatusGateSessionAtoms: ReadonlyArray<Atom<string | null>> = [];

export function registerRuntimeStatusGateSessionAtoms(
  atoms: ReadonlyArray<Atom<string | null>>
): void {
  runtimeStatusGateSessionAtoms = atoms;
}

export const setSessionRuntimeStatusAtom = atom(
  null,
  (
    get,
    set,
    update: {
      sessionId: string;
      status: CliSessionStatus;
      source: SessionRuntimeStatusSource;
    }
  ) => {
    if (runtimeStatusGateSessionAtoms.length > 0) {
      const gateValues = runtimeStatusGateSessionAtoms.map((sessionAtom) =>
        get(sessionAtom)
      );
      const matchesVisibleSession = gateValues.some(
        (value) => value === update.sessionId
      );
      // Cold-start / first-navigation window: both gate atoms can still be
      // null right after a hard reload or a session switch (activeSessionId is
      // not restored on reload, and the pipeline sessionIdAtom is only set once
      // loadSessionAtom runs). With no visible session established there is
      // nothing to bleed into, so fail open — otherwise an optimistic running
      // write dispatched in that window is silently dropped and the planning
      // footer never appears until the first authoritative backend event.
      const noVisibleSession = gateValues.every((value) => value === null);
      if (!matchesVisibleSession && !noVisibleSession) {
        // Write targets a session that is not visible — dropping it keeps the
        // global mirror owned by the visible session (no cross-session bleed).
        return;
      }
    }
    set(sessionRuntimeStatusAtom, update.status);
  }
);
setSessionRuntimeStatusAtom.debugLabel = "setSessionRuntimeStatus";

/** Error message from the last failed session run. Cleared on new run start. */
export const sessionRuntimeErrorAtom = atom<string | null>(null);
sessionRuntimeErrorAtom.debugLabel = "sessionRuntimeError";

/**
 * Transient stream-retry status.
 *
 * Set by the `agent:stream_retry` event when the Rust turn executor is
 * silently retrying a network-interrupted LLM call (per-chunk idle timeout,
 * transport drop, provider 5xx). Rendered as a low-key footer indicator
 * above the input area — NEVER as a chat bubble.
 *
 * Cleared on:
 * - `agent:stream_error_exhausted` (promoted to `sessionRuntimeErrorAtom`)
 * - next successful `agent:message_delta` / `agent:tool_call` after recovery
 * - `agent:complete`
 */
export interface StreamRetryStatus {
  sessionId: string;
  kind: string;
  attempt: number;
  maxAttempts: number;
  backoffMs: number;
  /** Epoch ms at which we received the event; used by the UI to animate the countdown. */
  startedAt: number;
}
export const streamRetryStatusAtom = atom<StreamRetryStatus | null>(null);
streamRetryStatusAtom.debugLabel = "streamRetryStatus";

/** Total tokens consumed in the current session. Updated via token_usage events. */
export const sessionContextTokensAtom = atom<number>(0);
sessionContextTokensAtom.debugLabel = "sessionContextTokens";

export type ContextUsageCategory =
  | "stable_prompt"
  | "dynamic_prompt"
  | "rules"
  | "skills"
  | "memory"
  | "conversation"
  | "tool_results"
  | "attachments"
  | "other"
  | "unattributed";

export interface ContextUsageItem {
  category: ContextUsageCategory;
  label: string;
  source: string;
  estimatedTokens: number;
  included: boolean;
  cacheStatus?: string | null;
  details?: string | null;
}

export interface ContextUsageSection {
  category: ContextUsageCategory;
  label: string;
  estimatedTokens: number;
  percent: number;
  items: ContextUsageItem[];
}

export interface ContextUsageSnapshot {
  usedTokens: number;
  maxTokens?: number | null;
  percentUsed?: number | null;
  updatedAt: string;
  sections: ContextUsageSection[];
  warnings: string[];
  /** Provider-reported cache-read tokens (Anthropic prompt caching). */
  cacheReadTokens?: number;
  /** Provider-reported cache-write tokens (new KV blocks written this turn). */
  cacheWriteTokens?: number;
}

export const sessionContextUsageAtom = atom<ContextUsageSnapshot | null>(null);
sessionContextUsageAtom.debugLabel = "sessionContextUsage";

/**
 * Deprecated compatibility shape for older agent:complete payloads.
 */
export interface ContextBreakdown {
  systemPromptTokens?: number;
  toolsTokens?: number;
  rulesTokens?: number;
  skillsTokens?: number;
  mcpTokens?: number;
  subagentTokens?: number;
  summaryTokens?: number;
  conversationTokens?: number;
}

/**
 * Set once per `agent:complete` event when Rust emits a context breakdown.
 * Null until the first complete event with breakdown data arrives.
 */
export const sessionContextBreakdownAtom = atom<ContextBreakdown | null>(null);
sessionContextBreakdownAtom.debugLabel = "sessionContextBreakdown";

/**
 * Pending-cancel flag.
 *
 * Set to `true` the moment the user clicks the stop button. Cleared when Rust
 * broadcasts a terminal status (the actual turn wind-down).
 *
 * Used by the "silent queue" UX: while this flag is true, any new user message
 * is enqueued (not dispatched) so the user never sees a "wait, the agent is
 * still stopping" state. User Stop never auto-flushes preserved queued
 * follow-ups; only an explicit Send Now or a later natural turn completion may
 * release them.
 */
export const isPendingCancelAtom = atom<boolean>(false);
isPendingCancelAtom.debugLabel = "isPendingCancel";

/**
 * User-initiated cancel flag.
 *
 * Set to `true` alongside `isPendingCancelAtom` when the user presses the stop
 * button (as opposed to a Rust-side failure that incidentally clears pending).
 * The queue flusher consumes this once after the cancel settles: instead of
 * auto-dispatching queued follow-ups, the active in-flight prompt is restored
 * to the input box so the user can edit/cancel before re-sending. The queued
 * follow-ups stay in place and auto-flush normally after the user resends (or
 * they can clear them manually).
 *
 * Cleared by `useQueueDispatch` after it consumes the restore, or on the next
 * fresh `status_changed -> running` event, whichever comes first.
 */
export const postStopDispatchSessionsAtom = atom<
  Readonly<Record<string, true>>
>({});
postStopDispatchSessionsAtom.debugLabel = "postStopDispatchSessions";

/** Open the post-Stop episode for exactly one session. */
export const openPostStopDispatchEpisodeAtom = atom(
  null,
  (_get, set, sessionId: string) => {
    set(postStopDispatchSessionsAtom, (current) => {
      if (current[sessionId]) return current;
      return { ...current, [sessionId]: true };
    });
  }
);
openPostStopDispatchEpisodeAtom.debugLabel = "openPostStopDispatchEpisode";

/** Close the post-Stop episode without affecting any other active session. */
export const closePostStopDispatchEpisodeAtom = atom(
  null,
  (_get, set, sessionId: string) => {
    set(postStopDispatchSessionsAtom, (current) => {
      if (!current[sessionId]) return current;
      const { [sessionId]: _removed, ...remaining } = current;
      return remaining;
    });
  }
);
closePostStopDispatchEpisodeAtom.debugLabel = "closePostStopDispatchEpisode";

/**
 * Pending "restore message to input box" signal.
 *
 * Set when a user-initiated cancel needs to put the active in-flight prompt
 * back into the composer. `useInputArea` observes this atom and injects the
 * text into the tiptap editor, then clears the signal.
 *
 * Object shape (not just a string) so we can include imageDataUrls in a
 * follow-up without another atom.
 */
export interface RestoreToInputPayload {
  /** Session the payload belongs to — composer must not consume cross-session. */
  sessionId: string;
  displayContent: string;
  imageDataUrls?: string[];
}
export const restoreToInputAtom = atom<RestoreToInputPayload | null>(null);
restoreToInputAtom.debugLabel = "restoreToInput";

/**
 * Last user message displayed in the current session. Captured at dispatch
 * time (not derived from events) so the cancel-restore path can put the
 * exact text + images the user typed back into the input box without
 * having to scan the event store.
 */
export interface LastUserMessagePayload {
  /** Session the message was dispatched into. Stop-restore must ignore
   * payloads captured by a different session (two sessions working in
   * parallel used to leak session B's prompt into session A's composer). */
  sessionId: string;
  displayContent: string;
  imageDataUrls?: string[];
}
export const lastUserMessageAtom = atom<LastUserMessagePayload | null>(null);
lastUserMessageAtom.debugLabel = "lastUserMessage";

/**
 * Set to `true` when the user cancels before any agent output (Scenario A),
 * causing the session to be rolled back to an empty state. Cleared when the
 * session starts running again (next message sent successfully).
 *
 * Used by ChatHistory to suppress the empty-activity reload error placeholder —
 * the session is intentionally empty, not broken.
 */
export const sessionRolledBackAtom = atom<boolean>(false);
sessionRolledBackAtom.debugLabel = "sessionRolledBack";

// ============================================
// Derived Status Atoms
// ============================================

/** Whether the session engine is actively running or blocked on user input/funds. */
export const isSessionEngineActiveAtom = atom<boolean>((get) => {
  const status = get(sessionRuntimeStatusAtom);
  return (
    status === "running" ||
    status === "installing" ||
    status === "waiting_for_user" ||
    status === "waiting_for_funds"
  );
});
isSessionEngineActiveAtom.debugLabel = "isSessionEngineActive";

/**
 * Universal "is any session actively working?" signal.
 *
 * Derives from `sessionRuntimeStatusAtom` (Rust-pushed) OR the injected
 * live-subagent signal. The latter covers the gap where the parent turn
 * has mechanically ended (runtime status = idle) but a background subagent
 * spawned via `agent(background: true)` is still running — without it the
 * composer would drop to Send state and the planning footer would vanish
 * while a child worker is clearly still alive.
 *
 * The live-subagent signal is injected by `viewAtom.ts` (which can read
 * both the pipeline `sessionIdAtom` and `subagentJobMapAtom`) via
 * `registerLiveSubagentSignalAtom`, mirroring the gate-atom registration
 * pattern above. Importing those atoms directly here would create an
 * import cycle. Before registration (tests, early startup) the signal is
 * absent and behavior degrades to the pure runtime-status read.
 */
let liveSubagentSignalAtom: Atom<boolean> | null = null;

export function registerLiveSubagentSignalAtom(
  signalAtom: Atom<boolean>
): void {
  liveSubagentSignalAtom = signalAtom;
}

export const isSessionActiveAtom = atom<boolean>((get) => {
  if (get(isSessionEngineActiveAtom)) return true;
  return liveSubagentSignalAtom ? get(liveSubagentSignalAtom) : false;
});
isSessionActiveAtom.debugLabel = "isSessionActive";

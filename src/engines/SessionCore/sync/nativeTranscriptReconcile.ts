/**
 * Post-turn reconcile for native-transcript CLI sessions.
 *
 * Native-mode sessions stream ephemeral (in-memory only) events during a
 * turn; the transcript of record is the CLI's own store, read back through
 * `cli_agent_chunks` (which routes to the imported-history loaders). When a
 * turn reaches a terminal status we reload once after a short settle delay
 * so the in-memory events are replaced by the canonical parse, and retry
 * once more in case the CLI flushed its store slightly after exiting.
 *
 * The registry is populated by the CLI adapter's postLoad (from
 * `cli_agent_status.transcriptSource`); legacy sessions never reconcile.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

const transcriptSourceBySession = new Map<string, string>();

const RECONCILE_SETTLE_MS = 600;
const RECONCILE_RETRY_MS = 2000;

export function registerSessionTranscriptSource(
  sessionId: string,
  transcriptSource: string | undefined
): void {
  if (transcriptSource) {
    transcriptSourceBySession.set(sessionId, transcriptSource);
  }
}

export function isNativeTranscriptSession(sessionId: string): boolean {
  return transcriptSourceBySession.get(sessionId) === "native";
}

interface ReconcileDeps {
  loadHistory: (sessionId: string) => Promise<SessionEvent[]>;
  dispatchLoadSession: (payload: {
    sessionId: string;
    events: SessionEvent[];
    /**
     * The native replay IS the canonical transcript: loadSessionAtom must
     * replace the in-memory turn events (synthetic user bubble, streamed
     * placeholders) instead of merging next to them — their ids never match
     * the replayed rows, so a merge renders every turn twice.
     */
    replace?: boolean;
  }) => void;
  /** The session still on screen? Stale reconciles are dropped. */
  isSessionLive: (sessionId: string) => boolean;
}

const pendingReconciles = new Set<string>();

export function scheduleNativeTranscriptReconcile(
  sessionId: string,
  deps: ReconcileDeps
): void {
  if (!isNativeTranscriptSession(sessionId)) return;
  if (pendingReconciles.has(sessionId)) return;
  pendingReconciles.add(sessionId);

  const runOnce = async (): Promise<number> => {
    if (!deps.isSessionLive(sessionId)) return -1;
    const events = await deps.loadHistory(sessionId);
    if (!deps.isSessionLive(sessionId)) return -1;
    if (events.length > 0) {
      deps.dispatchLoadSession({ sessionId, events, replace: true });
    }
    return events.length;
  };

  void (async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, RECONCILE_SETTLE_MS));
      const firstCount = await runOnce();
      if (firstCount < 0) return;
      // One retry catches a store flushed slightly after process exit; only
      // re-dispatch when the parse actually grew (no pointless flicker).
      await new Promise((resolve) => setTimeout(resolve, RECONCILE_RETRY_MS));
      if (!deps.isSessionLive(sessionId)) return;
      const events = await deps.loadHistory(sessionId);
      if (
        events.length > Math.max(firstCount, 0) &&
        deps.isSessionLive(sessionId)
      ) {
        deps.dispatchLoadSession({ sessionId, events, replace: true });
      }
    } catch {
      // Best-effort: the ephemeral in-memory events remain on screen; the
      // next session open replays from the native store anyway.
    } finally {
      pendingReconciles.delete(sessionId);
    }
  })();
}

/**
 * Post-turn reconcile for managed CLI sessions whose transcript of record is
 * the vendor's native store. Reconcile now asks the bounded replay transport
 * for true deltas; it never calls `cli_agent_chunks` or replaces history from
 * a session-sized JS array.
 */

const transcriptSourceBySession = new Map<string, string>();
const MAX_TRANSCRIPT_SOURCE_ENTRIES = 64;

const RECONCILE_SETTLE_MS = 600;
const RECONCILE_RETRY_MS = 2_000;

export function registerSessionTranscriptSource(
  sessionId: string,
  transcriptSource: string | undefined
): void {
  if (!transcriptSource) return;
  transcriptSourceBySession.delete(sessionId);
  transcriptSourceBySession.set(sessionId, transcriptSource);
  if (transcriptSourceBySession.size > MAX_TRANSCRIPT_SOURCE_ENTRIES) {
    const oldest = transcriptSourceBySession.keys().next().value;
    if (oldest) transcriptSourceBySession.delete(oldest);
  }
}

export function isNativeTranscriptSession(sessionId: string): boolean {
  return transcriptSourceBySession.get(sessionId) === "native";
}

interface ReconcileDeps {
  pollReplay: (sessionId: string) => Promise<void>;
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

  const runOnce = async (): Promise<boolean> => {
    if (!deps.isSessionLive(sessionId)) return false;
    await deps.pollReplay(sessionId);
    return deps.isSessionLive(sessionId);
  };

  void (async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, RECONCILE_SETTLE_MS));
      if (!(await runOnce())) return;
      // One bounded retry catches a native store flushed just after process
      // exit. Unchanged sources produce zero parse/upsert work in Rust.
      await new Promise((resolve) => setTimeout(resolve, RECONCILE_RETRY_MS));
      await runOnce();
    } catch {
      // Best effort: the visible fallback timer and the next open share the
      // same cursor, so they can safely complete the reconcile later.
    } finally {
      pendingReconciles.delete(sessionId);
    }
  })();
}

import type { DeleteSessionReceipt } from "@src/api/tauri/agent";

interface RustSessionDeleteCleanup {
  removeSession: (sessionId: string) => void;
  removeForkRelayEntry: (sessionId: string) => void;
  disposeWorkstationWorkspace: (sessionId: string) => void;
  clearPendingFileOpens: (sessionId: string) => void;
  clearPendingCodeEditorTab: (sessionId: string) => void;
  evictEventStore: (sessionId: string) => Promise<void>;
  closeSessionTabs: (sessionIds: readonly string[]) => boolean;
}

interface ApplyRustSessionDeleteReceiptOptions {
  requestedSessionId: string;
  activeSessionId: string;
  isAgentOrgRoot: boolean;
  receipt: DeleteSessionReceipt;
  cleanup: RustSessionDeleteCleanup;
}

/**
 * Apply the additional local cleanup described by a Rust deletion receipt.
 *
 * The requested row keeps the sidebar's existing single-session data cleanup
 * path. Chat tabs are receipt-owned, however, so every deleted Root/Member is
 * removed together before any caller decides whether a separate navigation
 * reset is still necessary.
 */
export async function applyRustSessionDeleteReceipt({
  requestedSessionId,
  activeSessionId,
  isAgentOrgRoot,
  receipt,
  cleanup,
}: ApplyRustSessionDeleteReceiptOptions): Promise<boolean> {
  const deletedSessionIds = [...new Set(receipt.deletedSessionIds)];
  for (const deletedSessionId of deletedSessionIds) {
    if (deletedSessionId === requestedSessionId) continue;
    cleanup.removeSession(deletedSessionId);
    cleanup.removeForkRelayEntry(deletedSessionId);
    cleanup.disposeWorkstationWorkspace(deletedSessionId);
    cleanup.clearPendingFileOpens(deletedSessionId);
    cleanup.clearPendingCodeEditorTab(deletedSessionId);
  }

  if (isAgentOrgRoot || deletedSessionIds.length > 1) {
    await Promise.all(
      deletedSessionIds.map((sessionId) => cleanup.evictEventStore(sessionId))
    );
  }

  const closedActiveSessionTab = cleanup.closeSessionTabs(deletedSessionIds);
  return deletedSessionIds.includes(activeSessionId) && !closedActiveSessionTab;
}

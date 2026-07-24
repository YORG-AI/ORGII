/**
 * Departing-session snapshot release for session action atoms.
 *
 * Module-level selector memoization is intentionally reference-stable while
 * a session is active, but must not become an accidental transcript cache
 * after the UI leaves it. Extracted from actions.ts.
 */
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import { resetChatEventsMemoCaches } from "../../derived/chatEvents";
import { eventStoreProxy } from "../store/EventStoreProxy";
import { resetContextAtomMemoCaches } from "./context";
import { resetEventAtomMemoCaches } from "./events";

export function releaseDepartingSessionSnapshot(sessionId: string): void {
  // Module-level selector memoization is intentionally reference-stable while
  // active, but must not become an accidental transcript cache after the UI
  // leaves the session. Clear it synchronously even for live sessions whose
  // Rust/bridge snapshot keeps the normal warm-switch grace period.
  resetEventAtomMemoCaches();
  resetContextAtomMemoCaches();
  resetChatEventsMemoCaches(sessionId);

  if (isImportedHistorySession(sessionId)) {
    // Imported transcripts are read-only and reloadable. They can contain
    // large tool payloads, so retaining them for the normal warm-switch grace
    // period multiplies JS heap after visiting several external sessions.
    // Release unconditionally: these sessions have no live agent stream to
    // preserve, and their active-only refresh hook has already stopped.
    eventStoreProxy.releaseSessionSnapshot(sessionId);
    return;
  }

  eventStoreProxy.scheduleSessionSnapshotRelease(sessionId);
}

import type { MutableRefObject } from "react";

import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";

import { unregisterPane } from "./terminalOutputScheduler";

export function cleanupPtyListeners({
  unlistenOutputRef,
  unlistenExitRef,
  sessionIdRef,
}: {
  unlistenOutputRef: MutableRefObject<(() => void) | null>;
  unlistenExitRef: MutableRefObject<(() => void) | null>;
  sessionIdRef: MutableRefObject<string | null>;
}) {
  if (unlistenOutputRef.current) {
    unlistenOutputRef.current();
    unlistenOutputRef.current = null;
  }

  if (unlistenExitRef.current) {
    unlistenExitRef.current();
    unlistenExitRef.current = null;
  }

  if (sessionIdRef.current) {
    const sessionId = sessionIdRef.current;
    unregisterPane(sessionId);
    if (isTauriReady()) {
      // Nobody is listening anymore: stop event emission and release the
      // flow-control window so a background CLI keeps running instead of
      // stalling against ACKs that will never arrive. Best-effort — the
      // backend also self-detaches on a stalled window.
      void invokeTauri("detach_pty_stream", { sessionId }).catch(
        () => undefined
      );
    }
    sessionIdRef.current = null;
  }
}

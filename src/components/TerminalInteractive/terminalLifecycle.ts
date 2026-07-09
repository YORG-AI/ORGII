import type { MutableRefObject } from "react";

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
    unregisterPane(sessionIdRef.current);
    sessionIdRef.current = null;
  }
}

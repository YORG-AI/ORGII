import { useEffect, useState } from "react";

import {
  type ContextCacheSnapshotResult,
  contextCacheSnapshot,
} from "@src/api/tauri/agent/contextCacheSnapshot";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("useContextCacheSnapshot");

export interface ContextCacheSnapshotState {
  snapshot: ContextCacheSnapshotResult | null;
  error: string | null;
}

export function useContextCacheSnapshot(
  sessionId: string | undefined,
  enabled: boolean
): ContextCacheSnapshotState {
  const [state, setState] = useState<ContextCacheSnapshotState>({
    snapshot: null,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let cancelled = false;
    contextCacheSnapshot(sessionId)
      .then((snapshot) => {
        if (cancelled) return;
        setState({ snapshot, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        log.debug("context cache snapshot unavailable", message);
        setState({ snapshot: null, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, sessionId]);

  return state;
}

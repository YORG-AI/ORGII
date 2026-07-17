import React, { useCallback, useState } from "react";

import { getSessionFiles } from "@src/api/tauri/agent";
import { useVisiblePolling } from "@src/hooks/async";

import {
  type SessionFileChange,
  type SessionFilesCache,
  TERMINAL_STATUS,
} from "../types";

interface UseSessionFilesOptions {
  sessionId: string;
  displayStatus: string;
  isActive: boolean;
  isTerminal: boolean;
  filesCache: React.MutableRefObject<SessionFilesCache>;
}

const POLL_INTERVAL_MS = 5_000;

export function useSessionFiles(options: UseSessionFilesOptions) {
  const { sessionId, displayStatus, isActive, isTerminal, filesCache } =
    options;

  const [sessionFiles, setSessionFiles] = useState<SessionFileChange[] | null>(
    () => filesCache.current.get(sessionId) ?? null
  );
  const [filesLoading, setFilesLoading] = useState(false);

  const loadSessionFiles = useCallback(
    async (signal?: AbortSignal) => {
      const cached = filesCache.current.get(sessionId);
      if (cached) {
        setSessionFiles(cached);
        return;
      }
      setFilesLoading(true);
      try {
        const files = (await getSessionFiles(
          sessionId
        )) as unknown as SessionFileChange[];
        if (signal?.aborted) return;
        if (TERMINAL_STATUS.has(displayStatus)) {
          filesCache.current.set(sessionId, files);
        }
        setSessionFiles(files);
      } catch {
        if (!signal?.aborted) setSessionFiles([]);
      } finally {
        if (!signal?.aborted) setFilesLoading(false);
      }
    },
    [sessionId, displayStatus, filesCache]
  );

  useVisiblePolling({
    enabled: isActive && !isTerminal,
    intervalMs: POLL_INTERVAL_MS,
    poll: loadSessionFiles,
  });

  return { sessionFiles, filesLoading, loadSessionFiles };
}

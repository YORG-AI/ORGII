import React, { useCallback, useEffect, useRef, useState } from "react";

import { getSessionFiles } from "@src/api/tauri/agent";
import { parseRawSessionEvent } from "@src/engines/SessionCore/core/schemas";
import { subscribeToSessionEvents } from "@src/engines/SessionCore/sync/useSessionChannel";

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

const EVENT_SETTLE_MS = 250;

export function useSessionFiles(options: UseSessionFilesOptions) {
  const { sessionId, displayStatus, isActive, isTerminal, filesCache } =
    options;

  const [sessionFiles, setSessionFiles] = useState<SessionFileChange[] | null>(
    () => filesCache.current.get(sessionId) ?? null
  );
  const [filesLoading, setFilesLoading] = useState(false);

  const loadSessionFiles = useCallback(
    async (force = false) => {
      const cached = filesCache.current.get(sessionId);
      if (cached && !force) {
        setSessionFiles(cached);
        return;
      }
      setFilesLoading(true);
      try {
        const files = (await getSessionFiles(
          sessionId
        )) as unknown as SessionFileChange[];
        if (TERMINAL_STATUS.has(displayStatus)) {
          filesCache.current.set(sessionId, files);
        }
        setSessionFiles(files);
      } catch {
        setSessionFiles([]);
      } finally {
        setFilesLoading(false);
      }
    },
    [sessionId, displayStatus, filesCache]
  );

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isTerminal || !isActive) return;
    let cancelled = false;
    const scheduleRefresh = (raw: string) => {
      if (cancelled || document.hidden) return;
      const event = parseRawSessionEvent(raw);
      if (event.type !== "agent:file_change") return;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        if (!cancelled) void loadSessionFiles(true);
      }, EVENT_SETTLE_MS);
    };
    void loadSessionFiles(true);
    const unsubscribe = subscribeToSessionEvents(sessionId, scheduleRefresh);
    return () => {
      cancelled = true;
      unsubscribe();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [sessionId, isActive, isTerminal, loadSessionFiles]);

  return { sessionFiles, filesLoading, loadSessionFiles };
}

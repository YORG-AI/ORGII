import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { eventsAtom } from "@src/engines/SessionCore/core/atoms";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { copyText } from "@src/util/data/clipboard";

import {
  type RawTranscriptSnapshot,
  loadRawSessionTranscript,
  mergeRawSessionEvents,
} from "./transcript";

interface SessionRawTranscriptState {
  error: string | null;
  sessionId: string;
  snapshot: RawTranscriptSnapshot | null;
}

export function useSessionRawTranscript(
  sessionId: string | null,
  enabled = true
) {
  const { t } = useTranslation("sessions");
  const liveEvents = useAtomValue(eventsAtom);
  const requestIdRef = useRef(0);
  const [state, setState] = useState<SessionRawTranscriptState | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);

  const loadTranscript = useCallback(async () => {
    if (!sessionId) return;
    const requestId = ++requestIdRef.current;
    setLoadingSessionId(sessionId);
    setState((current) =>
      current?.sessionId === sessionId
        ? { ...current, error: null }
        : { error: null, sessionId, snapshot: null }
    );
    try {
      const snapshot = await loadRawSessionTranscript(sessionId);
      if (requestId !== requestIdRef.current) return;
      setState({ error: null, sessionId, snapshot });
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setState({
        error:
          loadError instanceof Error ? loadError.message : String(loadError),
        sessionId,
        snapshot: null,
      });
    } finally {
      if (requestId === requestIdRef.current) setLoadingSessionId(null);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    void loadTranscript();
    return () => {
      requestIdRef.current += 1;
    };
  }, [enabled, loadTranscript, sessionId]);

  const snapshot = state?.sessionId === sessionId ? state.snapshot : null;
  const error = state?.sessionId === sessionId ? state.error : null;
  const loading = loadingSessionId === sessionId;
  const entries = useMemo(() => {
    if (!snapshot) return [];
    if (snapshot.source.kind !== "orgii-event-store") {
      return snapshot.entries;
    }
    return mergeRawSessionEvents(
      snapshot.entries as SessionEvent[],
      liveEvents,
      snapshot.sessionId
    );
  }, [liveEvents, snapshot]);
  const transcriptJson = useMemo(
    () => JSON.stringify(entries, null, 2),
    [entries]
  );

  const copyTranscript = useCallback(async () => {
    try {
      await copyText(transcriptJson);
      Message.success(
        t("chat.rawTranscript.copySuccess", {
          defaultValue: "Raw transcript copied",
        })
      );
    } catch {
      Message.error(
        t("chat.rawTranscript.copyFailed", {
          defaultValue: "Could not copy the raw transcript",
        })
      );
    }
  }, [t, transcriptJson]);

  return {
    copyTranscript,
    entries,
    error,
    loadTranscript,
    loading,
    snapshot,
    sourceLabel: snapshot?.source.displayName ?? "",
    transcriptJson,
  };
}

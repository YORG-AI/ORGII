import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { externalReplayStreamExportForTarget } from "@src/api/tauri/externalHistory/replay";
import Message from "@src/components/Message";
import { eventsAtom } from "@src/engines/SessionCore/core/atoms";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { copyText } from "@src/util/data/clipboard";

import {
  type RawTranscriptSnapshot,
  canCopyRawTranscript,
  loadOlderRawSessionTranscript,
  loadRawSessionTranscript,
  mergeRawSessionEvents,
  stringifyJsonArrayBounded,
} from "./transcript";

interface SessionRawTranscriptState {
  error: string | null;
  sessionId: string;
  snapshot: RawTranscriptSnapshot | null;
}

const COPY_ALL_MAX_BYTES = 4 * 1024 * 1024;

export function useSessionRawTranscript(
  sessionId: string | null,
  enabled = true
) {
  const { t } = useTranslation("sessions");
  const liveEvents = useAtomValue(eventsAtom);
  const requestIdRef = useRef(0);
  const [state, setState] = useState<SessionRawTranscriptState | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

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
  // Never build one session-sized JSON string for external replay. Native
  // EventStore retains the existing editor behaviour; replay rows are
  // serialized individually by the virtual list.
  const transcriptJson = useMemo(() => {
    if (snapshot?.source.kind === "external-history") return "";
    return JSON.stringify(entries, null, 2);
  }, [entries, snapshot?.source.kind]);

  const canCopyAll = canCopyRawTranscript(snapshot, COPY_ALL_MAX_BYTES);

  const loadOlder = useCallback(async () => {
    if (!snapshot?.replay?.hasOlder || loadingOlder) return;
    const requestId = requestIdRef.current;
    setLoadingOlder(true);
    try {
      const next = await loadOlderRawSessionTranscript(snapshot);
      if (requestId !== requestIdRef.current) return;
      setState({ error: null, sessionId: snapshot.sessionId, snapshot: next });
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setState({
        error:
          loadError instanceof Error ? loadError.message : String(loadError),
        sessionId: snapshot.sessionId,
        snapshot,
      });
    } finally {
      if (requestId === requestIdRef.current) setLoadingOlder(false);
    }
  }, [loadingOlder, snapshot]);

  const copyTranscript = useCallback(async () => {
    try {
      if (!snapshot || !canCopyAll) {
        throw new Error("Transcript exceeds the Copy All memory budget");
      }
      const copyValue =
        snapshot.source.kind === "external-history"
          ? stringifyJsonArrayBounded(entries, COPY_ALL_MAX_BYTES)
          : transcriptJson;
      if (copyValue === null) {
        throw new Error("Transcript exceeds the Copy All memory budget");
      }
      if (new TextEncoder().encode(copyValue).byteLength > COPY_ALL_MAX_BYTES) {
        throw new Error("Transcript exceeds the Copy All memory budget");
      }
      await copyText(copyValue);
      Message.success(
        t("chat.rawTranscript.copySuccess", {
          defaultValue: "Raw transcript copied",
        })
      );
    } catch {
      Message.error(
        t("chat.rawTranscript.copyFailed", {
          defaultValue:
            "This transcript is too large to copy safely. Use Export All instead.",
        })
      );
    }
  }, [canCopyAll, entries, snapshot, t, transcriptJson]);

  const exportTranscript = useCallback(async () => {
    if (!snapshot || snapshot.source.kind !== "external-history") return null;
    const safeSessionName =
      snapshot.sessionId.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 120) ||
      "session";
    return externalReplayStreamExportForTarget({
      target: snapshot.source.target,
      suggestedFileName: `raw-transcript-${safeSessionName}.json`,
      format: "json",
    });
  }, [snapshot]);

  return {
    canCopyAll,
    copyTranscript,
    entries,
    error,
    exportTranscript,
    loadOlder,
    loadTranscript,
    loadingOlder,
    loading,
    snapshot,
    sourceLabel: snapshot?.source.displayName ?? "",
    transcriptJson,
  };
}

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import type { RawTranscriptSnapshot } from "@src/engines/ChatPanel/components/SessionRawTranscriptDialog/transcript";
import type { SessionEvent } from "@src/engines/SessionCore";
import { copyText } from "@src/util/data/clipboard";

/** Browser adapter: raw transcript comes from the already-fetched cloud events. */
export function useWebSessionRawTranscript(
  sessionId: string | null,
  events: readonly SessionEvent[],
  enabled = true
) {
  const { t } = useTranslation("sessions");

  const snapshot = useMemo<RawTranscriptSnapshot | null>(() => {
    if (!enabled || !sessionId) return null;
    return {
      sessionId,
      source: {
        kind: "orgii-event-store",
        displayName: "ORG2 Cloud",
      },
      loadedAt: new Date().toISOString(),
      entries: [...events],
    };
  }, [enabled, events, sessionId]);

  const transcriptJson = useMemo(
    () => (snapshot ? JSON.stringify(snapshot.entries, null, 2) : ""),
    [snapshot]
  );

  const loadTranscript = useCallback(async () => {
    // Cloud events are caller-owned; refresh is handled by the page hook.
  }, []);

  const copyTranscript = useCallback(async () => {
    if (!transcriptJson) return;
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
    entries: snapshot?.entries ?? [],
    error: null,
    loadTranscript,
    loading: false,
    snapshot,
    sourceLabel: snapshot?.source.displayName ?? "",
    transcriptJson,
  };
}

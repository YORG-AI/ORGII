import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";

import {
  type ExternalReplayTarget,
  externalReplayReadPayloadRangeForTarget,
} from "@src/api/tauri/externalHistory/replay";
import { ReplayRequestGuard } from "@src/api/tauri/externalHistory/replayRequestGuard";
import Button from "@src/components/Button";
import type {
  PayloadRef,
  SessionEvent,
} from "@src/engines/SessionCore/core/types";
import { CodeMirrorEditor } from "@src/features/CodeMirror";

import {
  RAW_TRANSCRIPT_VIRTUAL_BASE_INDEX,
  type ReplayVirtualAnchorState,
  reconcileReplayVirtualAnchor,
} from "./replayVirtualAnchor";
import type { RawTranscriptSnapshot } from "./transcript";

const PAYLOAD_PAGE_BYTES = 256 * 1024;

type ReplayPayloadRef = PayloadRef & {
  replayGeneration?: string;
  replaySourceEventId?: string;
};

interface LoadedPayloadRange {
  key: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  totalBytes: number;
  text: string;
}

function ReplayPayloadRanges({
  event,
  generation,
  sessionId,
  target,
}: {
  event: SessionEvent;
  generation: string;
  sessionId: string;
  target: ExternalReplayTarget;
}) {
  const { t } = useTranslation("common");
  const [loaded, setLoaded] = useState<LoadedPayloadRange | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestGuard = useRef(new ReplayRequestGuard());
  const refs = (event.payloadRefs ?? []) as ReplayPayloadRef[];

  useEffect(() => {
    const guard = requestGuard.current;
    guard.invalidate();
    setLoaded(null);
    setLoadingKey(null);
    setError(null);
    return () => guard.invalidate();
  }, [event.id, generation, sessionId]);

  const readRange = useCallback(
    async (ref: ReplayPayloadRef, offset: number) => {
      const key = `${ref.fieldPath}:${offset}`;
      const requestEpoch = requestGuard.current.begin();
      setLoadingKey(key);
      setError(null);
      try {
        const range = await externalReplayReadPayloadRangeForTarget({
          target,
          generation: ref.replayGeneration ?? generation,
          eventId: ref.replaySourceEventId ?? event.chunk_id ?? ref.eventId,
          fieldPath: ref.fieldPath,
          offset,
          maxBytes: PAYLOAD_PAGE_BYTES,
        });
        if (!requestGuard.current.isCurrent(requestEpoch)) return;
        setLoaded({ key: ref.fieldPath, ...range });
      } catch (loadError) {
        if (!requestGuard.current.isCurrent(requestEpoch)) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        );
      } finally {
        if (requestGuard.current.isCurrent(requestEpoch)) {
          setLoadingKey(null);
        }
      }
    },
    [event.chunk_id, generation, target]
  );

  if (refs.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border-2 pt-2">
      {refs.map((ref) => {
        const isSelected = loaded?.key === ref.fieldPath;
        return (
          <div key={`${ref.eventId}:${ref.fieldPath}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-3">
              <span className="font-mono">{ref.fieldPath}</span>
              <span>{ref.fullSizeBytes.toLocaleString()} bytes</span>
              <Button
                size="small"
                loading={loadingKey === `${ref.fieldPath}:0`}
                onClick={() => void readRange(ref, 0)}
              >
                {t("showMore", { defaultValue: "Read payload" })}
              </Button>
            </div>
            {isSelected && loaded ? (
              <div className="mt-2 overflow-hidden rounded-md border border-border-2 bg-bg-1">
                <pre className="max-h-64 overflow-auto whitespace-pre p-3 text-xs text-text-2">
                  {loaded.text}
                </pre>
                <div className="flex items-center justify-between gap-2 border-t border-border-2 px-3 py-2 text-xs text-text-3">
                  <span>
                    {loaded.offset.toLocaleString()}–
                    {loaded.nextOffset.toLocaleString()} /{" "}
                    {loaded.totalBytes.toLocaleString()} bytes
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="small"
                      disabled={loaded.offset === 0}
                      loading={
                        loadingKey ===
                        `${ref.fieldPath}:${Math.max(0, loaded.offset - PAYLOAD_PAGE_BYTES)}`
                      }
                      onClick={() =>
                        void readRange(
                          ref,
                          Math.max(0, loaded.offset - PAYLOAD_PAGE_BYTES)
                        )
                      }
                    >
                      {t("actions.previous", { defaultValue: "Previous" })}
                    </Button>
                    <Button
                      size="small"
                      disabled={loaded.eof}
                      loading={
                        loadingKey === `${ref.fieldPath}:${loaded.nextOffset}`
                      }
                      onClick={() => void readRange(ref, loaded.nextOffset)}
                    >
                      {t("actions.next", { defaultValue: "Next" })}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {error ? (
        <div role="alert" className="text-xs text-danger-6">
          {error}
        </div>
      ) : null}
    </div>
  );
}

const ReplayEventRow = memo(
  ({
    event,
    generation,
    sessionId,
    target,
  }: {
    event: SessionEvent;
    generation: string;
    sessionId: string;
    target: ExternalReplayTarget;
  }) => {
    const json = useMemo(() => JSON.stringify(event, null, 2), [event]);
    return (
      <article className="mx-1 mb-2 rounded-lg border border-border-2 bg-bg-2 p-3">
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-text-3">
          <span className="min-w-0 truncate font-mono">{event.id}</span>
          <time className="shrink-0">{event.createdAt}</time>
        </div>
        <pre className="overflow-x-auto whitespace-pre text-xs leading-5 text-text-2">
          {json}
        </pre>
        <ReplayPayloadRanges
          event={event}
          generation={generation}
          sessionId={sessionId}
          target={target}
        />
      </article>
    );
  }
);

ReplayEventRow.displayName = "ReplayEventRow";

export interface SessionRawTranscriptContentProps {
  entries: SessionEvent[];
  error: string | null;
  filePath?: string;
  loading: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  snapshot: RawTranscriptSnapshot | null;
  transcriptJson: string;
}

const SessionRawTranscriptContent: React.FC<SessionRawTranscriptContentProps> =
  memo(
    ({
      entries,
      error,
      filePath,
      loading,
      loadingOlder,
      onLoadOlder,
      snapshot,
      transcriptJson,
    }) => {
      const { t } = useTranslation("common");
      const replay = snapshot?.replay;
      const replayTarget =
        snapshot?.source.kind === "external-history"
          ? snapshot.source.target
          : null;
      const [replayVirtualAnchor, setReplayVirtualAnchor] =
        useState<ReplayVirtualAnchorState | null>(null);
      let replayFirstItemIndex = Math.max(
        0,
        RAW_TRANSCRIPT_VIRTUAL_BASE_INDEX - entries.length
      );
      if (replayTarget && replay) {
        const nextAnchor = reconcileReplayVirtualAnchor(replayVirtualAnchor, {
          sessionId: snapshot.sessionId,
          generation: replay.cursor.generation,
          revision: replay.cursor.revision,
          throughSequence: replay.cursor.throughSequence,
          newerContentReleased: Boolean(replay.newerContentReleased),
          entries,
        });
        replayFirstItemIndex = nextAnchor.firstItemIndex;
        if (nextAnchor !== replayVirtualAnchor) {
          // React's adjust-state-during-render pattern ensures Virtuoso never
          // commits new rows with the previous logical index.
          setReplayVirtualAnchor(nextAnchor);
        }
      }
      const canRetryOlder =
        Boolean(replay?.hasOlder) &&
        !loadingOlder &&
        (Boolean(error) || Boolean(replay?.olderPageNeedsRetry));

      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&_.codemirror-editor-wrapper]:h-full">
          {error ? (
            <div
              role="alert"
              className="rounded-md border border-danger-6/40 bg-danger-1 px-3 py-2 text-sm text-danger-6"
            >
              {error}
            </div>
          ) : null}
          {replayTarget && replay ? (
            <Virtuoso
              className="min-h-0 flex-1"
              data={entries}
              firstItemIndex={replayFirstItemIndex}
              computeItemKey={(_, event) => event.id}
              startReached={() => {
                if (
                  replay.hasOlder &&
                  !loadingOlder &&
                  !replay.olderPageNeedsRetry &&
                  !error
                ) {
                  onLoadOlder();
                }
              }}
              components={{
                Header: () =>
                  loadingOlder ||
                  replay.newerContentReleased ||
                  canRetryOlder ? (
                    <div className="px-3 py-2 text-center text-xs text-text-3">
                      {loadingOlder ? (
                        t("status.loading", { defaultValue: "Loading…" })
                      ) : replay.newerContentReleased ? (
                        t("rawTranscript.newerReleased", {
                          defaultValue:
                            "Newer rows were released to keep memory bounded. Refresh to return to the latest turn.",
                        })
                      ) : (
                        <Button size="small" onClick={onLoadOlder}>
                          {t("actions.retry", { defaultValue: "Retry" })}
                        </Button>
                      )}
                    </div>
                  ) : null,
              }}
              itemContent={(_, event) => (
                <ReplayEventRow
                  event={event}
                  generation={replay.cursor.generation}
                  sessionId={snapshot.sessionId}
                  target={replayTarget}
                />
              )}
            />
          ) : (
            <CodeMirrorEditor
              value={
                loading && !snapshot
                  ? t("status.loading", { defaultValue: "Loading…" })
                  : transcriptJson
              }
              filePath={filePath}
              language="json"
              height="100%"
              readOnly
              enableLinting={false}
              enableDirtyDiff={false}
              registerWithService={false}
              enableGitBlame={false}
            />
          )}
        </div>
      );
    }
  );

SessionRawTranscriptContent.displayName = "SessionRawTranscriptContent";

export default SessionRawTranscriptContent;

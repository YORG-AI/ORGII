import { useVirtualizer } from "@tanstack/react-virtual";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type HumanSession,
  type HumanSessionEntry,
  appendHumanSessionEntry,
  getHumanSession,
} from "@src/api/tauri/humanSession";
import ComposerInput, {
  type ComposerInputRef,
} from "@src/components/ComposerInput";
import { COMPOSER_BOTTOM_DOCK_PADDING_CLASS } from "@src/config/composerStackTokens";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import InputArea from "@src/engines/ChatPanel/InputArea";
import {
  hasPillSyntax,
  parsePillTextToSnapshot,
} from "@src/engines/ChatPanel/InputArea/utils/pillContentParser";
import type { SubmitOverrideInput } from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { HugeiconsIcon, Loading03Icon } from "@src/icons";
import {
  ConnectedTimelineItem,
  TimelineCard,
  TimelineCardHeader,
  TimelineStack,
} from "@src/modules/shared/components/ActivityTimeline";
import { loadSessions } from "@src/store/session/sessionAtom/loaders";

interface HumanSessionViewProps {
  sessionId: string;
}

const WORK_LOG_SLASH_ITEM_CATEGORIES = ["skill"] as const;
const HUMAN_SESSION_VIRTUALIZATION_THRESHOLD = 20;
const HUMAN_SESSION_ESTIMATED_ENTRY_HEIGHT = 140;

const HumanSessionEntryBody: React.FC<{ entry: HumanSessionEntry }> = ({
  entry,
}) => {
  const { t } = useTranslation("sessions");
  const editorRef = useRef<ComposerInputRef | null>(null);

  useEffect(() => {
    editorRef.current?.setContent(
      hasPillSyntax(entry.body)
        ? parsePillTextToSnapshot(entry.body)
        : entry.body
    );
  }, [entry.body]);

  return (
    <ComposerInput
      ref={editorRef}
      ariaLabel={t("humanSession.entryLabel")}
      initialContent={entry.body}
      editable={false}
      minHeight={0}
      overflowY="visible"
      className="text-sm leading-6 text-text-1"
    />
  );
};

const HumanSessionView: React.FC<HumanSessionViewProps> = ({ sessionId }) => {
  const { t } = useTranslation("sessions");
  const [humanSession, setHumanSession] = useState<HumanSession | null>(null);
  const [loading, setLoading] = useState(true);
  const appendingRef = useRef(false);
  const appendGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    appendGenerationRef.current += 1;
    appendingRef.current = false;
    setAppending(false);
    setHumanSession(null);
    setLoading(true);
    setError(null);
    getHumanSession(sessionId)
      .then((next) => {
        if (generation === loadGenerationRef.current) setHumanSession(next);
      })
      .catch((loadError) => {
        if (generation === loadGenerationRef.current) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : t("humanSession.loadFailed")
          );
        }
      })
      .finally(() => {
        if (generation === loadGenerationRef.current) setLoading(false);
      });
    return () => {
      if (generation === loadGenerationRef.current) {
        loadGenerationRef.current += 1;
      }
      appendGenerationRef.current += 1;
      appendingRef.current = false;
    };
  }, [sessionId, t]);

  const handleAppend = useCallback(
    async ({ displayText }: SubmitOverrideInput): Promise<boolean> => {
      const note = displayText.trim();
      if (!note || appendingRef.current) return true;

      const appendGeneration = ++appendGenerationRef.current;
      const loadGeneration = loadGenerationRef.current;
      appendingRef.current = true;
      setAppending(true);
      setError(null);
      try {
        const next = await appendHumanSessionEntry(sessionId, note);
        if (
          appendGeneration !== appendGenerationRef.current ||
          loadGeneration !== loadGenerationRef.current
        ) {
          return true;
        }
        setHumanSession(next);
        await loadSessions({ forceRefresh: true }).catch(() => undefined);
        return true;
      } catch (appendError) {
        if (
          appendGeneration !== appendGenerationRef.current ||
          loadGeneration !== loadGenerationRef.current
        ) {
          return true;
        }
        const message =
          appendError instanceof Error
            ? appendError.message
            : t("humanSession.appendFailed");
        if (
          appendGeneration === appendGenerationRef.current &&
          loadGeneration === loadGenerationRef.current
        ) {
          setError(message);
        }
        throw appendError instanceof Error ? appendError : new Error(message);
      } finally {
        if (
          appendGeneration === appendGenerationRef.current &&
          loadGeneration === loadGenerationRef.current
        ) {
          appendingRef.current = false;
          setAppending(false);
        }
      }
    },
    [sessionId, t]
  );

  const entries = humanSession?.entries ?? [];
  const entryCount = entries.length;
  const shouldVirtualize = entryCount > HUMAN_SESSION_VIRTUALIZATION_THRESHOLD;
  const entryVirtualizer = useVirtualizer({
    count: shouldVirtualize ? entryCount : 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => HUMAN_SESSION_ESTIMATED_ENTRY_HEIGHT,
    getItemKey: (index) => entries[index]?.id ?? index,
    overscan: 5,
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (shouldVirtualize && entryCount > 0) {
        entryVirtualizer.scrollToIndex(entryCount - 1, { align: "end" });
        return;
      }
      const container = scrollContainerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [entryCount, entryVirtualizer, sessionId, shouldVirtualize]);

  const renderEntry = (entry: HumanSessionEntry, entryIndex: number) => (
    <ConnectedTimelineItem isLast={entryIndex === entries.length - 1}>
      <TimelineCard
        copyBody={entry.body}
        header={
          <TimelineCardHeader
            actor={t("humanSession.entryLabel")}
            action={null}
            timestamp={entry.createdAt}
          />
        }
      >
        <HumanSessionEntryBody entry={entry} />
      </TimelineCard>
    </ConnectedTimelineItem>
  );

  if (loading) {
    return (
      <div
        role="status"
        aria-label={t("humanSession.loading")}
        className="flex h-full items-center justify-center text-text-3"
      >
        <HugeiconsIcon
          icon={Loading03Icon}
          data-icon="loader-2"
          className="animate-spin"
          size={20}
        />
      </div>
    );
  }

  if (!humanSession) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-danger-6">
        {error ?? t("humanSession.loadFailed")}
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={scrollContainerRef}
        className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto px-2"
      >
        <main
          className={`mx-auto min-h-full w-full px-2 pb-36 pt-6 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
        >
          {shouldVirtualize ? (
            <div
              className="relative min-w-0"
              style={{ height: entryVirtualizer.getTotalSize() }}
            >
              {entryVirtualizer.getVirtualItems().map((virtualEntry) => {
                const entry = entries[virtualEntry.index];
                return (
                  <div
                    key={entry.id}
                    ref={entryVirtualizer.measureElement}
                    data-index={virtualEntry.index}
                    className="absolute left-0 top-0 w-full"
                    style={{
                      transform: `translateY(${virtualEntry.start}px)`,
                    }}
                  >
                    {renderEntry(entry, virtualEntry.index)}
                  </div>
                );
              })}
            </div>
          ) : (
            <TimelineStack>
              {entries.map((entry, entryIndex) => (
                <React.Fragment key={entry.id}>
                  {renderEntry(entry, entryIndex)}
                </React.Fragment>
              ))}
            </TimelineStack>
          )}
        </main>
      </div>

      <footer
        className={`absolute bottom-0 left-0 right-0 z-50 flex w-full flex-col items-center px-2 pt-1 ${COMPOSER_BOTTOM_DOCK_PADDING_CLASS}`}
        data-testid="human-session-composer"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 top-[-28px] bg-gradient-to-t from-chat-pane via-chat-pane/90 to-transparent"
        />
        <div
          className={`relative z-10 flex w-full flex-col gap-1.5 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
        >
          {error && (
            <div role="alert" className="px-2 text-xs text-danger-6">
              {error}
            </div>
          )}
          <InputArea
            key={sessionId}
            omitChatHeader
            bottomAnchored
            sessionId={sessionId}
            sessionScope="none"
            placeholder={t("humanSession.appendPlaceholder")}
            onSubmitOverride={handleAppend}
            submitDisabled={appending}
            disableStopWhenEmpty
            showAgentControls={false}
            allowFileAttachments={false}
            enableAgentInterceptors={false}
            slashItemCategories={WORK_LOG_SLASH_ITEM_CATEGORIES}
          />
        </div>
      </footer>
    </div>
  );
};

export default HumanSessionView;

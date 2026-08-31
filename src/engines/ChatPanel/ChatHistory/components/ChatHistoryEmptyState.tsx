/**
 * ChatHistoryEmptyState
 *
 * Renders the loading spinner or "No activity yet" placeholder depending
 * on `loadStatus` and empty-state confirmation.  Extracted from
 * `ChatHistory/index.tsx` to keep that file under the 600-line limit.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { ChatLoadingBlock } from "@src/engines/ChatPanel/blocks/primitives";
import type { SessionLoadStatus } from "@src/engines/SessionCore";
import CloudSessionDownloadProgressCard from "@src/features/Org2Cloud/CloudSessionDownloadProgressCard";
import { useCloudSessionHasDownloadSurface } from "@src/features/Org2Cloud/useCloudSessionDownloadSurface";

interface ChatHistoryEmptyStateProps {
  /** Session this surface renders; drives the cloud download progress card. */
  sessionId?: string | null;
  /** `"loaded"` when the session history has finished loading. */
  sessionLoadStatus: SessionLoadStatus;
  /** Last session load error, if loading failed. */
  sessionLoadError: string | null;
  /** True once the empty-state grace window has expired. */
  emptyConfirmed: boolean;
  /**
   * True while the user is still inside the grace window (or the session
   * just rolled back). Shows a spinner rather than the reload prompt.
   */
  shouldShowEmpty: boolean;
  /** True if the session view was rolled back (cancel-before-output). */
  isRolledBack: boolean;
  /** True while a large history is being projected in the Web Worker. */
  projectionPending?: boolean;
  /** Called when the user clicks the "Reload" action. */
  onReload: () => void;
}

const ChatHistoryLoadingState: React.FC = () => (
  <div className="p-2">
    <ChatLoadingBlock />
  </div>
);

const ChatHistoryEmptyState: React.FC<ChatHistoryEmptyStateProps> = memo(
  ({
    sessionId,
    sessionLoadStatus,
    sessionLoadError,
    emptyConfirmed,
    shouldShowEmpty,
    isRolledBack,
    projectionPending = false,
    onReload,
  }) => {
    const { t } = useTranslation();
    // A live/paused cloud download — or a big session waiting on its Start
    // click — owns the whole pane, and it outranks EVERY branch below: a
    // paused fresh download has zero local events, and the confirmed-empty
    // placeholder would otherwise evict the paused card into a bewildering
    // "No activity yet".
    const hasDownloadSurface = useCloudSessionHasDownloadSurface(sessionId);

    if (hasDownloadSurface) {
      return (
        <CloudSessionDownloadProgressCard
          sessionId={sessionId}
          variant="centered"
        />
      );
    }

    if (projectionPending) {
      return <ChatHistoryLoadingState />;
    }

    if (sessionLoadStatus === "error") {
      return (
        <Placeholder
          variant="error"
          placement="sidebar"
          title={t("placeholders.failedToLoadHistory")}
          subtitle={sessionLoadError ?? t("placeholders.chatHistoryReloadHint")}
          action={{
            label: t("actions.reload"),
            onClick: onReload,
          }}
        />
      );
    }

    if (sessionLoadStatus !== "loaded") {
      return <ChatHistoryLoadingState />;
    }

    if (shouldShowEmpty && emptyConfirmed && !isRolledBack) {
      return (
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={t("placeholders.chatHistoryEmpty")}
          subtitle={t("placeholders.chatHistoryReloadHint")}
          action={{
            label: t("actions.reload"),
            onClick: onReload,
          }}
        />
      );
    }

    if (shouldShowEmpty) {
      return <ChatHistoryLoadingState />;
    }

    return (
      <Placeholder
        variant="empty"
        placement="sidebar"
        title={t("placeholders.chatHistoryAgentWorking")}
        subtitle={t("placeholders.chatHistoryAgentWorkingHint")}
      />
    );
  }
);

ChatHistoryEmptyState.displayName = "ChatHistoryEmptyState";

export default ChatHistoryEmptyState;

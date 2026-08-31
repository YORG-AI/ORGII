import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@src/components/IconButton";
import { PermissionSheet } from "@src/components/PermissionPrompt";
import { HugeiconsIcon, StopCircleIcon } from "@src/icons";

import { useMobileRemote } from "../app";
import { MobileTopBar } from "../components/MobileTopBar";
import { MobileComposer } from "../components/composer/MobileComposer";
import { ChatTranscript } from "../components/transcript/ChatTranscript";
import { RoundNavigator } from "../components/transcript/RoundNavigator";

export interface SessionChatScreenProps {
  sessionId: string;
  sessionName: string;
  sendCapability?: "native" | "external_codex" | "read_only";
  onBack?: () => void;
  onOpenStopModal?: () => void;
}

/** M-08 Chat + M-11 Permission Sheet (via interaction queue). */
export function SessionChatScreen({
  sessionId,
  sessionName,
  sendCapability = "native",
  onBack,
  onOpenStopModal,
}: SessionChatScreenProps) {
  const { t } = useTranslation("mobileRemote");
  const {
    connection,
    transcriptItems,
    transcriptPhase,
    transcriptError,
    transcriptTruncated,
    transcriptRounds,
    transcriptRoundsComplete,
    selectedRoundId,
    activeRoundId,
    sendStatus,
    activePermission,
    permissionQueueDepth,
    sendMessage,
    openSessionFileInDesktop,
    respondPermission,
    subscribeSession,
    unsubscribeSession,
    selectRound,
    retrySelectedRound,
  } = useMobileRemote();

  useEffect(() => {
    void subscribeSession(sessionId).catch(() => undefined);
    return () => {
      void unsubscribeSession();
    };
  }, [sessionId, subscribeSession, unsubscribeSession]);

  const writable =
    connection.status === "connected" &&
    connection.presence === "online" &&
    connection.tier !== "read_only";
  const sendSupported = sendCapability !== "read_only";
  const composerDisabled = !writable || !sendSupported;
  const permissionOpen =
    activePermission != null && activePermission.sessionId === sessionId;
  const canOpenDesktopFile =
    writable &&
    Boolean(activeRoundId) &&
    connection.capabilities?.openSessionFile === true;

  const handleSend = useCallback(
    async (content: string) => {
      await sendMessage(sessionId, content);
    },
    [sendMessage, sessionId]
  );

  const handleOpenDesktopFile = useCallback(
    async (eventId: string, target: { targetIndex: number }) => {
      if (!activeRoundId) return;
      await openSessionFileInDesktop(
        sessionId,
        activeRoundId,
        eventId,
        target.targetIndex
      );
    },
    [activeRoundId, openSessionFileInDesktop, sessionId]
  );

  const activeSendStatus =
    sendStatus?.sessionId === sessionId ? sendStatus : null;
  const waitingForAgent =
    (activeSendStatus?.phase === "submitting" ||
      activeSendStatus?.phase === "accepted") &&
    !transcriptItems.some((item) => item.kind !== "user");
  const composerStatus = activeSendStatus
    ? activeSendStatus.phase === "submitting"
      ? t("composerSending")
      : activeSendStatus.phase === "accepted"
        ? t("composerAccepted")
        : activeSendStatus.phase === "uncertain"
          ? t("composerUncertain")
          : activeSendStatus.phase === "completed"
            ? t("composerCompleted")
            : activeSendStatus.message || t("composerSendFailed")
    : undefined;

  const handleRetryHistory = useCallback(() => {
    if (activeRoundId) {
      retrySelectedRound();
    } else {
      void subscribeSession(sessionId).catch(() => undefined);
    }
  }, [activeRoundId, retrySelectedRound, sessionId, subscribeSession]);

  const handleAllow = useCallback(() => {
    void respondPermission("allow");
  }, [respondPermission]);

  const handleDeny = useCallback(() => {
    void respondPermission("deny");
  }, [respondPermission]);

  const handleAlwaysAllow = useCallback(() => {
    void respondPermission("always_allow");
  }, [respondPermission]);

  return (
    <>
      <MobileTopBar
        title={sessionName}
        onBack={onBack}
        trailing={
          <IconButton
            type="button"
            size="sm"
            variant="danger"
            aria-label={t("stopConfirm.confirm")}
            onClick={onOpenStopModal}
            disabled={!writable || !sendSupported}
          >
            <HugeiconsIcon icon={StopCircleIcon} size={16} />
          </IconButton>
        }
      />
      <div className="relative flex min-h-0 flex-1 flex-col bg-chat-container">
        <RoundNavigator
          rounds={transcriptRounds}
          roundsComplete={transcriptRoundsComplete}
          truncated={transcriptTruncated}
          selectedRoundId={selectedRoundId}
          onSelectRound={selectRound}
        />
        <ChatTranscript
          sessionId={sessionId}
          roundId={activeRoundId}
          items={transcriptItems}
          phase={transcriptPhase}
          error={transcriptError}
          forceFollowKey={activeSendStatus?.turnIntentId}
          waitingForAgent={waitingForAgent}
          onOpenFile={canOpenDesktopFile ? handleOpenDesktopFile : undefined}
          onRetry={handleRetryHistory}
        />
        <MobileComposer
          disabled={composerDisabled}
          disabledReason={
            !sendSupported
              ? t("composerReadOnly")
              : composerDisabled
                ? t("composerOffline")
                : undefined
          }
          statusMessage={composerStatus}
          statusTone={
            activeSendStatus?.phase === "failed" ||
            activeSendStatus?.phase === "cancelled" ||
            activeSendStatus?.phase === "uncertain"
              ? "error"
              : "neutral"
          }
          onSend={handleSend}
        />
      </div>
      <PermissionSheet
        open={permissionOpen}
        request={permissionOpen ? activePermission : null}
        desktopName={connection.desktopName}
        queueDepth={permissionQueueDepth}
        submitting={!writable}
        onAllow={handleAllow}
        onDeny={handleDeny}
        onAlwaysAllow={handleAlwaysAllow}
      />
    </>
  );
}

SessionChatScreen.displayName = "SessionChatScreen";

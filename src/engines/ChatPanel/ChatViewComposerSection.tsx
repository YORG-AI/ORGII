import { memo } from "react";

import ChatFloatingComposer from "./ChatFloatingComposer";
import type { ChatViewComposerSectionProps } from "./ChatViewComposerSection.types";
import { buildCompactFilesReloadKey } from "./InputArea/components/compactFileChangesHelpers";
import { useChatViewComposerSignals } from "./hooks/useChatViewComposerSignals";

export type { ChatViewComposerSectionProps } from "./ChatViewComposerSection.types";

export const ChatViewComposerSection = memo(function ChatViewComposerSection(
  props: ChatViewComposerSectionProps
) {
  const {
    sessionId,
    inputAreaSessionId,
    showMainComposer,
    streamRetry,
    ...composerProps
  } = props;

  const {
    currentPlanApproval,
    isAgentWorking,
    chatRoundCount,
    showCurrentPlanSurface,
    currentPlanSurfaceState,
    canvasPreviewPill,
  } = useChatViewComposerSignals(sessionId, inputAreaSessionId);

  const composerFilesReloadKey = buildCompactFilesReloadKey(
    inputAreaSessionId,
    chatRoundCount,
    isAgentWorking
  );

  if (!showMainComposer) {
    return null;
  }

  return (
    <ChatFloatingComposer
      {...composerProps}
      sessionId={sessionId}
      inputAreaSessionId={inputAreaSessionId}
      currentPlanApproval={currentPlanApproval}
      shouldShowCurrentPlanSurface={showCurrentPlanSurface}
      currentPlanSurfaceState={currentPlanSurfaceState}
      filesReloadKey={composerFilesReloadKey}
      canvasPreview={canvasPreviewPill}
      streamRetry={streamRetry}
    />
  );
});

ChatViewComposerSection.displayName = "ChatViewComposerSection";

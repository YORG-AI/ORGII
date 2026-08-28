import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";

import { useChatViewCanvasPreview } from "@src/engines/ChatPanel/hooks/useChatViewCanvasPreview";
import { derivePlanApprovalViewState } from "@src/engines/SessionCore/derived/planDisplayEvents";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import { usePendingPlanApproval } from "@src/hooks/session/usePendingPlanApproval";
import { isSessionActiveAtom } from "@src/store/session/cliSessionStatusAtom";

import { countChatRounds } from "../InputArea/components/compactFileChangesHelpers";

function chatRoundCountEqual(a: number, b: number): boolean {
  return a === b;
}

/**
 * Composer-only signals derived from the pipeline session. Kept separate from
 * the transcript subscription so streaming tokens do not re-render plan/canvas
 * surfaces unless the derived signal actually changes.
 */
export function useChatViewComposerSignals(
  planSessionId: string,
  eventSessionId: string
) {
  const currentPlanApproval = usePendingPlanApproval(planSessionId);
  const isAgentWorking = useAtomValue(isSessionActiveAtom);

  const chatRoundCountAtom = useMemo(
    () =>
      selectAtom(
        chatEventsForSessionAtomFamily(eventSessionId),
        (events) => countChatRounds(events),
        chatRoundCountEqual
      ),
    [eventSessionId]
  );
  const chatRoundCount = useAtomValue(chatRoundCountAtom);

  const planViewStateAtom = useMemo(
    () =>
      selectAtom(
        chatEventsForSessionAtomFamily(eventSessionId),
        (chatEvents) =>
          derivePlanApprovalViewState({
            pendingPlan: currentPlanApproval,
            chatEvents,
            displayEvents: chatEvents,
          }),
        (previous, next) =>
          previous.currentSurfaceVisible === next.currentSurfaceVisible &&
          previous.activePendingEvent?.id === next.activePendingEvent?.id
      ),
    [eventSessionId, currentPlanApproval]
  );
  const planViewState = useAtomValue(planViewStateAtom);

  const canvasPreviewPill = useChatViewCanvasPreview(planSessionId);

  return {
    currentPlanApproval,
    isAgentWorking,
    chatRoundCount,
    planViewState,
    showCurrentPlanSurface: planViewState.currentSurfaceVisible,
    currentPlanSurfaceState: planViewState.activePendingEvent
      ? planViewState.getEventState(planViewState.activePendingEvent, "current")
      : undefined,
    canvasPreviewPill,
  };
}

import { useAtomValue } from "jotai";
import type { ComponentProps, FC } from "react";
import { useEffect } from "react";

import { manualCompactInFlightSessionAtom } from "@src/engines/ChatPanel/hooks/useManualCompact";
import { useStreamingDeltaForSession } from "@src/engines/SessionCore";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import { usePlanningIndicator } from "@src/engines/SessionCore/hooks";
import { useConversationRunnerScope } from "@src/features/Org2Cloud/SessionConversation/conversationRunnerScope";

import ChatHistoryList from "./ChatHistoryList";

interface PlanningIndicatorBridgeProps extends Omit<
  ComponentProps<typeof ChatHistoryList>,
  "planningIndicatorCount" | "planningVariantIndex" | "planningFooterMode"
> {
  planningIndicatorScope: { sessionId: string; isLive: boolean } | null;
  planningIndicatorEnabled: boolean;
  onPlanningIndicatorCount: (count: 0 | 1) => void;
}

/**
 * Isolates the hot planning/streaming subscriptions from the history
 * orchestrator so streaming tokens do not re-render the whole history tree.
 */
const PlanningIndicatorBridge: FC<PlanningIndicatorBridgeProps> = ({
  planningIndicatorScope,
  planningIndicatorEnabled,
  onPlanningIndicatorCount,
  ...chatHistoryListProps
}) => {
  // A member's turn runs in an invisible local runner; when one is in flight
  // the indicator must scope to it, not to the idle mounted conversation
  // session, or a long turn shows no "Thinking…" and looks frozen.
  const runnerScope = useConversationRunnerScope();
  const effectiveScope = runnerScope
    ? { sessionId: runnerScope, isLive: true }
    : planningIndicatorScope;
  const { count, variantIndex } = usePlanningIndicator(effectiveScope);
  const activeSessionId = useAtomValue(sessionIdAtom);
  const scopedSessionId = effectiveScope?.sessionId ?? activeSessionId;
  const liveDelta = useStreamingDeltaForSession(scopedSessionId);
  const isAgentTyping = liveDelta?.kind === "message";
  const compactingSessionId = useAtomValue(manualCompactInFlightSessionAtom);
  const isCompacting =
    scopedSessionId !== null && compactingSessionId === scopedSessionId;
  const planningFooterMode = isCompacting
    ? "compacting"
    : isAgentTyping
      ? "agentTyping"
      : "planning";
  const visibleCount = isCompacting
    ? 1
    : planningIndicatorEnabled
      ? isAgentTyping
        ? 1
        : count
      : 0;

  useEffect(() => {
    onPlanningIndicatorCount(visibleCount);
  }, [visibleCount, onPlanningIndicatorCount]);

  return (
    <ChatHistoryList
      {...chatHistoryListProps}
      planningIndicatorCount={visibleCount}
      planningVariantIndex={variantIndex}
      planningFooterMode={planningFooterMode}
    />
  );
};

PlanningIndicatorBridge.displayName = "PlanningIndicatorBridge";

export default PlanningIndicatorBridge;

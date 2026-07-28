import { useAtomValue } from "jotai";
import type { ComponentProps, FC } from "react";
import { useEffect } from "react";

import { manualCompactInFlightSessionAtom } from "@src/engines/ChatPanel/hooks/useManualCompact";
import { useStreamingDeltaForSession } from "@src/engines/SessionCore";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import { usePlanningIndicator } from "@src/engines/SessionCore/hooks";

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
  const { count, variantIndex } = usePlanningIndicator(planningIndicatorScope);
  const activeSessionId = useAtomValue(sessionIdAtom);
  const scopedSessionId = planningIndicatorScope?.sessionId ?? activeSessionId;
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

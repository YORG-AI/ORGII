import { useAtomValue } from "jotai";
import type { ComponentProps, FC } from "react";
import { useEffect } from "react";

import { useAgentStatusTrail } from "@src/engines/ChatPanel/hooks/useAgentStatusTrail";
import { manualCompactInFlightSessionAtom } from "@src/engines/ChatPanel/hooks/useManualCompact";
import { useStreamingDeltaForSession } from "@src/engines/SessionCore";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import { globalPlanningIndicatorBridgeOutputAtom } from "@src/engines/SessionCore/derived/planningIndicatorBridgeOutputAtom";
import {
  type PlanningIndicatorScope,
  type PlanningIndicatorState,
  usePlanningIndicator,
} from "@src/engines/SessionCore/hooks/replay/usePlanningIndicator";
import { useConversationRunnerScope } from "@src/features/Org2Cloud/SessionConversation/conversationRunnerScope";

import ChatHistoryList from "./ChatHistoryList";

interface PlanningIndicatorBridgeProps extends Omit<
  ComponentProps<typeof ChatHistoryList>,
  | "planningIndicatorCount"
  | "planningVariantIndex"
  | "planningFooterMode"
  | "statusTrail"
  | "statusTrailSessionId"
> {
  planningIndicatorScope: PlanningIndicatorScope | null;
  planningIndicatorEnabled: boolean;
  onPlanningIndicatorCount: (count: 0 | 1) => void;
  /**
   * Epoch ms of the running turn's user message, anchoring the status
   * trail's elapsed readout to the same instant the finished turn's
   * "Agent worked for X" bar measures from.
   */
  tailTurnStartedAtMs: number | null;
  /** Epoch ms of the newest event, for the trail's quiet-session timeout. */
  tailTurnLastActivityAtMs: number | null;
}

interface PlanningIndicatorBridgeContentProps extends Omit<
  PlanningIndicatorBridgeProps,
  "planningIndicatorScope"
> {
  effectiveScope: PlanningIndicatorScope | null;
  planningState: PlanningIndicatorState;
}

function PlanningIndicatorBridgeContent({
  effectiveScope,
  planningState,
  planningIndicatorEnabled,
  onPlanningIndicatorCount,
  tailTurnStartedAtMs,
  tailTurnLastActivityAtMs,
  ...chatHistoryListProps
}: PlanningIndicatorBridgeContentProps) {
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
  const { count, variantIndex } = planningState;
  const visibleCount = isCompacting
    ? 1
    : planningIndicatorEnabled
      ? isAgentTyping
        ? 1
        : count
      : 0;
  // Same subscriptions the planning line already isolates here, so the hot
  // per-second tick stays inside this bridge instead of re-rendering the
  // whole history tree.
  const statusTrail = useAgentStatusTrail({
    sessionId: scopedSessionId,
    turnStartedAtMs: tailTurnStartedAtMs,
    lastActivityAtMs: tailTurnLastActivityAtMs,
    enabled: planningIndicatorEnabled,
    scopedIsLive: effectiveScope ? effectiveScope.isLive : null,
  });

  useEffect(() => {
    onPlanningIndicatorCount(visibleCount);
  }, [visibleCount, onPlanningIndicatorCount]);

  return (
    <ChatHistoryList
      {...chatHistoryListProps}
      planningIndicatorCount={visibleCount}
      planningVariantIndex={variantIndex}
      planningFooterMode={planningFooterMode}
      statusTrail={statusTrail}
      statusTrailSessionId={scopedSessionId}
    />
  );
}

function ScopedPlanningIndicatorBridge({
  effectiveScope,
  ...props
}: PlanningIndicatorBridgeProps & {
  effectiveScope: PlanningIndicatorScope;
}) {
  const planningState = usePlanningIndicator(effectiveScope);
  return (
    <PlanningIndicatorBridgeContent
      {...props}
      effectiveScope={effectiveScope}
      planningState={planningState}
    />
  );
}

function GlobalPlanningIndicatorBridge(props: PlanningIndicatorBridgeProps) {
  const planningState = useAtomValue(globalPlanningIndicatorBridgeOutputAtom);
  return (
    <PlanningIndicatorBridgeContent
      {...props}
      effectiveScope={null}
      planningState={planningState}
    />
  );
}

/**
 * Isolates the hot planning/streaming subscriptions from the history
 * orchestrator so streaming tokens do not re-render the whole history tree.
 *
 * Global mode reads the output atom synced by GlobalPlanningIndicatorBridgeSync
 * so the primary ChatPanel does not mount a second usePlanningIndicator tree.
 */
const PlanningIndicatorBridge: FC<PlanningIndicatorBridgeProps> = ({
  planningIndicatorScope,
  ...props
}) => {
  const runnerScope = useConversationRunnerScope();
  const effectiveScope = runnerScope
    ? { sessionId: runnerScope, isLive: true }
    : planningIndicatorScope;

  if (effectiveScope) {
    return (
      <ScopedPlanningIndicatorBridge
        {...props}
        planningIndicatorScope={planningIndicatorScope}
        effectiveScope={effectiveScope}
      />
    );
  }

  return (
    <GlobalPlanningIndicatorBridge
      {...props}
      planningIndicatorScope={planningIndicatorScope}
    />
  );
};

PlanningIndicatorBridge.displayName = "PlanningIndicatorBridge";

export default PlanningIndicatorBridge;

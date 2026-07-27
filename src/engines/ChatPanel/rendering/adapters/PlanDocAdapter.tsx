/**
 * PlanDocAdapter — renders `create_plan` events via `CreatePlanCard`.
 *
 * Plan cards render from running raw create_plan args for streaming draft UI,
 * then from backend-authored plan revision events once the plan is submitted.
 * Submitted raw create_plan tool calls can render when the lifecycle event is not in the live snapshot yet.
 *
 * The Build button itself is owned by `CreatePlanCard`; adapter logic is
 * intentionally thin.
 */
import { useAtomValue } from "jotai";
import React from "react";

import { chatEventsAtom } from "@src/engines/SessionCore/derived/chatEvents";
import { resolvePlanMarkdownContent } from "@src/engines/SessionCore/derived/planContentPersistence";
import {
  asPlanApprovalStatus,
  derivePlanApprovalViewState,
  getPlanSubmittedPayloadFromResult,
} from "@src/engines/SessionCore/derived/planDisplayEvents";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { usePendingPlanApproval } from "@src/hooks/session/usePendingPlanApproval";

import CreatePlanCard from "../../blocks/CreatePlanCard";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const PlanDocAdapter: React.FC<UniversalEventProps> = (props) => {
  const pendingPlan = usePendingPlanApproval(props.sessionId);
  const chatEvents = useAtomValue(chatEventsAtom);
  const eventForIdentity = chatEvents.find(
    (event) => event.id === props.eventId
  );
  const content = eventForIdentity
    ? resolvePlanMarkdownContent(eventForIdentity, pendingPlan)
    : pendingPlan &&
        props.callId &&
        (pendingPlan.planRevisionId === props.callId ||
          pendingPlan.toolCallId === props.callId ||
          pendingPlan.originToolCallId === props.callId)
      ? pendingPlan.planContent
      : asString(props.args?.["streamContent"]) ||
        asString(props.args?.["content"]);
  const title = asString(props.args?.["title"]);
  const submittedMatchesPending = Boolean(
    getPlanSubmittedPayloadFromResult(props.result)?.submitted_for_review ===
      true &&
    pendingPlan &&
    props.callId &&
    (pendingPlan.planRevisionId === props.callId ||
      pendingPlan.toolCallId === props.callId ||
      pendingPlan.originToolCallId === props.callId)
  );
  const planId =
    asString(props.args?.["planId"]) ||
    asString(props.result?.["planId"]) ||
    (submittedMatchesPending ? (pendingPlan?.planId ?? "") : "");
  const planRevisionId =
    asString(props.args?.["planRevisionId"]) ||
    asString(props.result?.["planRevisionId"]) ||
    (submittedMatchesPending ? (pendingPlan?.planRevisionId ?? "") : "");
  const approvalStatus = asPlanApprovalStatus(props.result?.["status"]);
  const planViewState = derivePlanApprovalViewState({
    pendingPlan,
    chatEvents,
    displayEvents: chatEvents,
  });
  const planSurface = props.planSurface ?? "transcript";
  const surfaceState = eventForIdentity
    ? planViewState.getEventState(eventForIdentity, planSurface)
    : undefined;

  const toolName = props.functionName || props.eventType;
  const hasActivePlanDraft =
    (props.status === "running" || props.status === "pending") &&
    (!planId || !planRevisionId);
  const isStreamingDraft =
    hasActivePlanDraft && props.showActiveEventPainting === true;

  if (!hasActivePlanDraft && (!planId || !planRevisionId)) return null;

  return (
    <div data-tool-call-event-id={props.eventId} data-tool-call-name={toolName}>
      <CreatePlanCard
        content={content}
        title={title}
        isStreaming={isStreamingDraft}
        toolCallId={props.callId}
        planId={planId || undefined}
        planRevisionId={planRevisionId || props.callId}
        sessionId={props.sessionId}
        eventId={planRevisionId || props.callId || props.eventId}
        surface={planSurface}
        approvalStatus={surfaceState?.status ?? approvalStatus}
        ownsPendingPlan={surfaceState?.ownsActions ?? false}
        surfaceState={surfaceState}
        toolUsage={props.toolUsage}
      />
    </div>
  );
};

PlanDocAdapter.displayName = "PlanDocAdapter";

export default PlanDocAdapter;

import React from "react";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { ApprovalRequestEvent } from "@src/engines/ChatPanel/events/interactive_events/approval";
import { AskQuestionEvent } from "@src/engines/ChatPanel/events/interactive_events/ask-question";
import { ModeSwitchEvent } from "@src/engines/ChatPanel/events/interactive_events/mode-switch";
import PlanDocAdapter from "@src/engines/ChatPanel/rendering/adapters/PlanDocAdapter";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isPlanDisplayEvent } from "@src/engines/SessionCore/derived/planDisplayEvents";
import type { RawEventInput } from "@src/engines/SessionCore/rendering/props";

import { InteractionBubble, PlanBubble } from "../ChatBubble";
import type { MessageEntry } from "../types";
import { isAskQuestionEvent } from "../utils";
import { planAdapterStatus } from "./planDocViewModel";

const APPROVAL_FUNCTIONS = new Set<string>([
  "approval_request",
  "ask_user_permissions",
  "approval_response",
]);

const MODE_SWITCH_FUNCTIONS = new Set<string>([
  "suggest_mode_switch",
  "mode_switch",
]);

function isApprovalEvent(event: SessionEvent): boolean {
  return APPROVAL_FUNCTIONS.has(event.functionName?.toLowerCase() || "");
}

function isModeSwitchEvent(event: SessionEvent): boolean {
  return MODE_SWITCH_FUNCTIONS.has(event.functionName?.toLowerCase() || "");
}

export function renderPlanDocCard(
  message: MessageEntry,
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>
): React.ReactNode {
  const event = message.event;
  return (
    <PlanBubble key={message.eventId} message={message} orgMembers={orgMembers}>
      <PlanDocAdapter
        eventId={event.id}
        eventType={event.uiCanonical || event.functionName}
        functionName={event.functionName}
        callId={event.callId}
        sessionId={event.sessionId}
        args={event.args}
        result={event.result}
        status={planAdapterStatus(event)}
        timestamp={event.createdAt}
        variant="chat"
        context="chat"
        planSurface="communication"
      />
    </PlanBubble>
  );
}

function replayEventInput(event: SessionEvent): RawEventInput {
  return { event };
}

export function renderInteractionWidget(
  message: MessageEntry,
  _onOpenPreview?: (eventId: string) => void,
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>
): React.ReactNode | null {
  const eventProps = replayEventInput(message.event);
  let widget: React.ReactNode = null;
  if (isPlanDisplayEvent(message.event)) {
    return renderPlanDocCard(message, orgMembers);
  }
  if (isAskQuestionEvent(message.event)) {
    widget = <AskQuestionEvent {...eventProps} variant="simulator" />;
  } else if (isApprovalEvent(message.event)) {
    widget = <ApprovalRequestEvent {...eventProps} />;
  } else if (isModeSwitchEvent(message.event)) {
    widget = <ModeSwitchEvent {...eventProps} />;
  }
  if (!widget) return null;
  return (
    <InteractionBubble
      key={message.eventId}
      message={message}
      orgMembers={orgMembers}
    >
      {widget}
    </InteractionBubble>
  );
}

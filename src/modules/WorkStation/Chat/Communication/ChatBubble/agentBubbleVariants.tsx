import React, { memo, useMemo } from "react";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { extractTodoData } from "@src/engines/SessionCore/rendering/props";
import { normalizeActivity } from "@src/lib/activityData";

import type { MessageEntry } from "../types";
import { AgentFramedBubble } from "./AgentFramedBubble";
import { CommunicationTodoList } from "./CommunicationTodoList";

export const TodoBubble: React.FC<{
  message: MessageEntry;
  onClick?: () => void;
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
}> = memo(({ message, onClick, orgMembers }) => {
  const todos = useMemo(() => {
    const normalized = normalizeActivity(
      message.event as unknown as Record<string, unknown>
    );

    return extractTodoData({
      eventId: message.eventId,
      eventType: "manage_todo",
      args: normalized.args,
      result: normalized.result,
      status: "success",
      variant: "simulator",
      context: "simulator",
      rustExtracted: message.event.extracted,
    }).todos;
  }, [message.event, message.eventId]);

  return (
    <AgentFramedBubble
      message={message}
      onClick={onClick}
      unframed
      titleKind="todo"
      orgMembers={orgMembers}
    >
      <CommunicationTodoList todos={todos} />
    </AgentFramedBubble>
  );
});
TodoBubble.displayName = "TodoBubble";

export const InteractionBubble: React.FC<{
  message: MessageEntry;
  onClick?: () => void;
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
  children: React.ReactNode;
}> = memo(({ message, onClick, orgMembers, children }) => (
  <AgentFramedBubble
    message={message}
    onClick={onClick}
    unframed
    titleKind="interaction"
    orgMembers={orgMembers}
  >
    {children}
  </AgentFramedBubble>
));
InteractionBubble.displayName = "InteractionBubble";

export const PlanBubble: React.FC<{
  message: MessageEntry;
  onClick?: () => void;
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
  children: React.ReactNode;
}> = memo(({ message, onClick, orgMembers, children }) => (
  <AgentFramedBubble
    message={message}
    onClick={onClick}
    unframed
    titleKind="plan"
    orgMembers={orgMembers}
  >
    {children}
  </AgentFramedBubble>
));
PlanBubble.displayName = "PlanBubble";

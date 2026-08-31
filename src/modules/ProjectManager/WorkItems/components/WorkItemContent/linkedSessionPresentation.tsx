/**
 * Presentation helpers for the Work Item linked-session table: status colors,
 * agent labels and the per-session agent icon.
 */
import React from "react";

import Org2SessionIcon from "@src/assets/modelIcons/org2-session.svg";
import AnyIcon from "@src/components/AnyIcon";
import { BotIcon, ComputerTerminal01Icon } from "@src/icons";
import type { LinkedSession } from "@src/types/core/workItem";

export const LINKED_SESSION_STATUS_COLOR: Record<
  LinkedSession["status"],
  string
> = {
  running: "var(--color-primary-6)",
  completed: "var(--color-success-6)",
  failed: "var(--color-danger-6)",
  cancelled: "var(--color-warning-6)",
};

export const LINKED_SESSION_AGENT_LABEL: Record<
  LinkedSession["agent_role"],
  string
> = {
  coding: "Coding",
  sde: "SDE",
  review: "Review",
  orchestrator: "Orchestrator",
  custom: "Custom",
  sub_agent: "Sub-agent",
};

export function formatLinkedSessionAgentLabel(session: LinkedSession): string {
  return (
    session.sub_agent_name ?? LINKED_SESSION_AGENT_LABEL[session.agent_role]
  );
}

export function formatOriginSessionAgentLabel(actorId: string): string {
  const agentId = actorId.replace(/^agent:/, "");
  return (
    LINKED_SESSION_AGENT_LABEL[agentId as LinkedSession["agent_role"]] ??
    agentId
  );
}

export function renderSessionAgentIcon(
  sessionType: "native" | "cli",
  provider?: string
) {
  if (provider === "org2" || (!provider && sessionType === "native")) {
    return (
      <Org2SessionIcon
        className="size-3.5 shrink-0"
        data-agent-provider="org2"
        aria-hidden="true"
      />
    );
  }

  const AgentIcon = sessionType === "cli" ? ComputerTerminal01Icon : BotIcon;
  return (
    <AnyIcon
      icon={AgentIcon}
      size={14}
      strokeWidth={1.75}
      className="shrink-0 text-text-3"
      aria-hidden="true"
    />
  );
}

export function getLinkedSessionTitle(session: LinkedSession): string {
  if (session.result_preview) return session.result_preview;
  if (session.sub_agent_name) return session.sub_agent_name;
  return session.session_id;
}

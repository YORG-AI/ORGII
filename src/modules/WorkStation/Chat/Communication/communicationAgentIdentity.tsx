import { useAtomValue } from "jotai";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { CLI_AGENT } from "@src/api/types/keys";
import { formatAgentType } from "@src/assets/providers";
import AnyIcon from "@src/components/AnyIcon";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { BotIcon, HugeiconsIcon } from "@src/icons";
import { type Session, sessionByIdAtom } from "@src/store/session/sessionAtom";
import { prettifyMemberName } from "@src/util/data/formatters/memberName";
import {
  isCursorIdeSession,
  resolveSessionIconId,
} from "@src/util/session/sessionDispatch";

export const COMMUNICATION_AVATAR_ICON_SIZE = 14;

const CURSOR_AGENT_LABEL = "Cursor Agent";

export interface CommunicationAgentIdentity {
  rawAgentName: string;
  agentIcon: React.ReactNode;
  isAgentOrgBubble: boolean;
}

export function resolveSenderName(
  event: SessionEvent,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView> | undefined,
  fallbackLabel: string
): string {
  if (!orgMembers || orgMembers.length === 0) return fallbackLabel;
  const match = orgMembers.find(
    (member) => member.sessionRuntime?.sessionId === event.sessionId
  );
  if (!match) return fallbackLabel;
  return match.name?.trim() || prettifyMemberName(match.memberId);
}

function resolveSessionAgentName(
  session: Session | undefined,
  sessionId: string
): string {
  if (session?.agentDisplayName?.trim()) return session.agentDisplayName.trim();
  if (isCursorIdeSession(sessionId)) return CURSOR_AGENT_LABEL;
  if (session?.cliAgentType === CLI_AGENT.CURSOR) return CURSOR_AGENT_LABEL;
  if (session?.cliAgentType) return formatAgentType(session.cliAgentType);
  return "Agent";
}

function resolveSessionAgentIcon(
  session: Session | undefined,
  sessionId: string
): React.ReactNode {
  if (session?.cliAgentType) {
    return (
      <ModelIcon
        agentType={session.cliAgentType}
        size={COMMUNICATION_AVATAR_ICON_SIZE}
      />
    );
  }
  if (isCursorIdeSession(sessionId)) {
    return (
      <ModelIcon
        agentType={CLI_AGENT.CURSOR}
        size={COMMUNICATION_AVATAR_ICON_SIZE}
      />
    );
  }
  const icon = resolveAgentIcon(
    session?.agentIconId ?? resolveSessionIconId(sessionId)
  );
  return (
    <AnyIcon
      icon={icon}
      size={COMMUNICATION_AVATAR_ICON_SIZE}
      className="text-primary-6"
    />
  );
}

export function useCommunicationAgentIdentity(
  event: SessionEvent,
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>
): CommunicationAgentIdentity {
  const { t } = useTranslation("common");
  const session = useAtomValue(sessionByIdAtom(event.sessionId ?? ""));
  const isAgentOrgBubble = Boolean(orgMembers && orgMembers.length > 0);

  return useMemo(() => {
    if (isAgentOrgBubble) {
      return {
        rawAgentName: resolveSenderName(
          event,
          orgMembers,
          t("terminology.agent")
        ),
        agentIcon: (
          <HugeiconsIcon
            icon={BotIcon}
            data-icon="bot"
            size={COMMUNICATION_AVATAR_ICON_SIZE}
            className="text-primary-6"
          />
        ),
        isAgentOrgBubble,
      };
    }

    return {
      rawAgentName: resolveSessionAgentName(session, event.sessionId),
      agentIcon: resolveSessionAgentIcon(session, event.sessionId),
      isAgentOrgBubble,
    };
  }, [event, isAgentOrgBubble, orgMembers, session, t]);
}

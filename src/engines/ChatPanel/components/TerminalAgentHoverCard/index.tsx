import { Activity, Clock3, Cpu, Folder, Wrench } from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import HoverCardBase, {
  HoverCardPanel,
  type HoverCardPosition,
  HoverCardRow,
} from "@src/components/SessionHoverCard/HoverCardBase";
import {
  type TerminalSession,
  getTerminalDisplayTitle,
} from "@src/engines/TerminalCore/types";

import {
  TERMINAL_AGENT_STATUS_PRESENTATION,
  formatTerminalAgentDuration,
} from "./presentation";

interface TerminalAgentHoverCardProps {
  session: TerminalSession;
  children: React.ReactElement;
  position?: HoverCardPosition;
}

const TerminalAgentHoverCardContent = memo(
  function TerminalAgentHoverCardContent({
    session,
  }: {
    session: TerminalSession;
  }) {
    const { t } = useTranslation();
    const status = session.agentStatus;
    const activity = session.agentActivity;
    const statusPresentation = status
      ? TERMINAL_AGENT_STATUS_PRESENTATION[status]
      : null;

    return (
      <HoverCardPanel title={getTerminalDisplayTitle(session)}>
        {statusPresentation && (
          <HoverCardRow
            icon={<Activity size={13} strokeWidth={1.75} />}
            iconClassName={statusPresentation.iconClass}
          >
            <span>
              {t(statusPresentation.labelKey, {
                defaultValue: statusPresentation.defaultLabel,
              })}
            </span>
          </HoverCardRow>
        )}

        {(activity?.toolName || activity?.toolInputPreview) && (
          <HoverCardRow icon={<Wrench size={13} strokeWidth={1.75} />}>
            <div className="min-w-0">
              {activity.toolName && (
                <span className="font-medium text-text-2">
                  {activity.toolName}
                </span>
              )}
              {activity.toolName && activity.toolInputPreview && (
                <span className="mx-1 text-text-4">·</span>
              )}
              {activity.toolInputPreview && (
                <span className="break-words text-text-3">
                  {activity.toolInputPreview}
                </span>
              )}
            </div>
          </HoverCardRow>
        )}

        {activity?.model && (
          <HoverCardRow icon={<Cpu size={13} strokeWidth={1.75} />}>
            <div className="truncate" title={activity.model}>
              {activity.model}
            </div>
          </HoverCardRow>
        )}

        {activity?.cwd && (
          <HoverCardRow icon={<Folder size={13} strokeWidth={1.75} />}>
            <div className="truncate" title={activity.cwd}>
              {activity.cwd}
            </div>
          </HoverCardRow>
        )}

        {activity?.durationMs !== undefined && (
          <HoverCardRow icon={<Clock3 size={13} strokeWidth={1.75} />}>
            {formatTerminalAgentDuration(activity.durationMs)}
          </HoverCardRow>
        )}
      </HoverCardPanel>
    );
  }
);

export default function TerminalAgentHoverCard({
  session,
  children,
  position = "bottom-start",
}: TerminalAgentHoverCardProps): React.ReactNode {
  const renderContent = useCallback(
    () => <TerminalAgentHoverCardContent session={session} />,
    [session]
  );

  return (
    <HoverCardBase
      cardId={`terminal-agent:${session.id}`}
      position={position}
      renderContent={renderContent}
    >
      {children}
    </HoverCardBase>
  );
}

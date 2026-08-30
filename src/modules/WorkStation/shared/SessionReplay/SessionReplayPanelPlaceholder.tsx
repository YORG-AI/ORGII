/**
 * Empty state for session replay bottom panel tabs when the session has no
 * trajectory events or no todo events yet.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";

export type SessionReplayPanelPlaceholderVariant = "trajectory" | "todo";

export interface SessionReplayPanelPlaceholderProps {
  variant: SessionReplayPanelPlaceholderVariant;
}

export const SessionReplayPanelPlaceholder: React.FC<SessionReplayPanelPlaceholderProps> =
  memo(({ variant }) => {
    const { t } = useTranslation("sessions");

    const title =
      variant === "trajectory"
        ? t("simulator.replay.bottomPanel.placeholderTrajectoryTitle")
        : t("simulator.replay.bottomPanel.placeholderTodoTitle");
    const subtitle =
      variant === "trajectory"
        ? t("simulator.replay.bottomPanel.placeholderTrajectorySubtitle")
        : t("simulator.replay.bottomPanel.placeholderTodoSubtitle");

    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <Placeholder
          variant="empty"
          placement="sidebar"
          fillParentHeight
          title={title}
          subtitle={subtitle}
        />
      </div>
    );
  });
SessionReplayPanelPlaceholder.displayName = "SessionReplayPanelPlaceholder";

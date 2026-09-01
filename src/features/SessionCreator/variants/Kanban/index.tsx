import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { SESSION_CREATOR_LAUNCH_MODE } from "@src/features/SessionCreator/types";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";

import SessionCreatorChatPanel from "../ChatPanel";

interface SessionCreatorKanbanProps {
  className?: string;
  onSessionStart?: () => void;
  onClose?: () => void;
}

const SessionCreatorKanban: React.FC<SessionCreatorKanbanProps> = ({
  className,
  onSessionStart,
  onClose,
}) => {
  const { t } = useTranslation("sessions");

  const handleSessionStart = useCallback(() => {
    onSessionStart?.();
  }, [onSessionStart]);

  const leadingActionSlot = onClose ? (
    <Button
      variant="secondary"
      appearance="outline"
      size="small"
      shape="round"
      iconOnly
      icon={
        <HugeiconsIcon
          icon={Cancel01Icon}
          data-icon="x"
          size={14}
          strokeWidth={1.75}
        />
      }
      title={t("tooltips.hidePanel")}
      aria-label={t("tooltips.hidePanel")}
      onClick={onClose}
      className="shrink-0"
    />
  ) : undefined;

  return (
    <SessionCreatorChatPanel
      className={className}
      dropdownDirection="up"
      headerLayout="compact"
      hidePresenceButton
      leadingActionSlot={leadingActionSlot}
      launchMode={SESSION_CREATOR_LAUNCH_MODE.START_BACKGROUND}
      onSessionStart={handleSessionStart}
    />
  );
};

export default SessionCreatorKanban;

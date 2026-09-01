import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { HugeiconsIcon, type IconSvgElement } from "@src/icons";

interface AgentControlToolbarProps {
  onNewRound: () => void;
  onPreviousActivity: () => void;
  onNextActivity: () => void;
  onLatestActivity: () => void;
  hasPreviousActivity: boolean;
  hasNextActivity: boolean;
  previousIcon: IconSvgElement;
  nextIcon: IconSvgElement;
  latestIcon: IconSvgElement;
}

export const AgentControlToolbar: React.FC<AgentControlToolbarProps> = ({
  onNewRound,
  onPreviousActivity,
  onNextActivity,
  onLatestActivity,
  hasPreviousActivity,
  hasNextActivity,
  previousIcon,
  nextIcon,
  latestIcon,
}) => {
  const { t } = useTranslation("common");

  return (
    <div className="flex items-center gap-1 border-t border-border-2/50 px-3 py-2">
      <Button
        variant="tertiary"
        size="mini"
        shape="round"
        htmlType="button"
        onClick={onNewRound}
      >
        {t("adeManager.newRound")}
      </Button>
      <Button
        variant="tertiary"
        size="mini"
        shape="circle"
        htmlType="button"
        icon={
          <HugeiconsIcon icon={previousIcon} size={12} strokeWidth={1.75} />
        }
        iconOnly
        disabled={!hasPreviousActivity}
        aria-label={t("actions.previous")}
        onClick={onPreviousActivity}
      />
      <Button
        variant="tertiary"
        size="mini"
        shape="circle"
        htmlType="button"
        icon={<HugeiconsIcon icon={nextIcon} size={12} strokeWidth={1.75} />}
        iconOnly
        disabled={!hasNextActivity}
        aria-label={t("actions.next")}
        onClick={onNextActivity}
      />
      <Button
        variant="tertiary"
        size="mini"
        shape="circle"
        htmlType="button"
        icon={<HugeiconsIcon icon={latestIcon} size={12} strokeWidth={1.75} />}
        iconOnly
        disabled={!hasNextActivity}
        aria-label={t("actions.next")}
        onClick={onLatestActivity}
      />
    </div>
  );
};

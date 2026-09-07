import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import {
  ArrowBigDownDashIcon,
  ArrowBigRightDashIcon,
  HugeiconsIcon,
} from "@src/icons";
import type { SecondaryPanelPosition } from "@src/store/ui/workStationAtom";

interface PanelPositionToggleProps {
  position: SecondaryPanelPosition;
  onToggle: () => void;
}

export const PanelPositionToggle: React.FC<PanelPositionToggleProps> = memo(
  ({ position, onToggle }) => {
    const { t } = useTranslation();
    const title =
      position === "right"
        ? t("tooltips.movePanelToBottom")
        : t("tooltips.movePanelToRight");
    const targetIcon =
      position === "right" ? ArrowBigDownDashIcon : ArrowBigRightDashIcon;
    const targetIconName =
      position === "right" ? "arrow-big-down-dash" : "arrow-big-right-dash";

    return (
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        onClick={onToggle}
        title={title}
        icon={
          <HugeiconsIcon
            icon={targetIcon}
            data-icon={targetIconName}
            size={HEADER_ICON_SIZE.md}
          />
        }
      />
    );
  }
);

PanelPositionToggle.displayName = "PanelPositionToggle";

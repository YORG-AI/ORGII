import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ArrowLeftRightIcon, HugeiconsIcon } from "@src/icons";
import type { SecondaryPanelPosition } from "@src/store/ui/workStationAtom";

import { HEADER_ICON_SIZE } from "../tokens";

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
            icon={ArrowLeftRightIcon}
            data-icon="arrow-left-right"
            size={HEADER_ICON_SIZE.md}
          />
        }
      />
    );
  }
);

PanelPositionToggle.displayName = "PanelPositionToggle";

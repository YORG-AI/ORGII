import React, { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { HugeiconsIcon, InformationCircleIcon } from "@src/icons";

import { HEADER_ICON_SIZE } from "./tokens";

export interface TerminalInfoButtonProps {
  title: string;
  name: string;
  pid?: number;
  shell?: string;
}

const TerminalInfoButtonComponent: React.FC<TerminalInfoButtonProps> = ({
  title,
  name,
  pid,
  shell,
}) => {
  const { t } = useTranslation();
  const [showTerminalInfo, setShowTerminalInfo] = useState(false);

  return (
    <div
      className="relative"
      onMouseEnter={() => setShowTerminalInfo(true)}
      onMouseLeave={() => setShowTerminalInfo(false)}
    >
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        title={t("tooltips.showTerminalProcessInfo")}
        icon={
          <HugeiconsIcon
            icon={InformationCircleIcon}
            data-icon="info"
            size={HEADER_ICON_SIZE.md}
          />
        }
      />

      {showTerminalInfo ? (
        <div
          className={`absolute right-0 top-full z-50 mt-2 ${DROPDOWN_CLASSES.panel} p-3 ${DROPDOWN_WIDTHS.panelWidthClass}`}
        >
          <div className="space-y-2 text-[13px]">
            <div className="mb-2 border-b border-border-2 pb-1.5 font-bold text-text-1">
              {title}
            </div>
            <div className="flex items-center justify-between gap-6">
              <span className="font-bold text-text-3">
                {t("common:common.name")}:
              </span>
              <span className="truncate font-bold text-text-1">{name}</span>
            </div>
            {pid !== undefined ? (
              <div className="flex items-center justify-between gap-6">
                <span className="font-bold text-text-3">
                  {t("common:common.pid")}:
                </span>
                <span className="font-bold text-text-1">{pid}</span>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-6">
              <span className="font-bold text-text-3">
                {t("common:common.shell")}:
              </span>
              <span className="truncate font-bold text-text-1">
                {shell ?? "zsh"}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const TerminalInfoButton = memo(TerminalInfoButtonComponent);
TerminalInfoButton.displayName = "TerminalInfoButton";

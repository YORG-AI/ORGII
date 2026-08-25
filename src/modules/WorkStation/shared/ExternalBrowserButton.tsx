import { Chrome } from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button, { type ButtonProps } from "@src/components/Button";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import { WorkstationToolbarTooltip } from "./WorkstationToolbarTooltip";

export interface ExternalBrowserButtonProps {
  href: string;
  label?: string;
  className?: string;
  dataTestId?: string;
  onClick?: ButtonProps["onClick"];
}

/** Chrome-glyph header action with the standard shortcut-style tooltip. */
export const ExternalBrowserButton = memo(function ExternalBrowserButton({
  href,
  label,
  className,
  dataTestId,
  onClick,
}: ExternalBrowserButtonProps) {
  const { t } = useTranslation("common");
  const resolvedLabel =
    label ?? t("previews.openInExternalBrowser", "Open in external browser");
  const handleClick: NonNullable<ButtonProps["onClick"]> = (event) => {
    onClick?.(event);
    if (!event.defaultPrevented) {
      void openExternalLink(href);
    }
  };

  return (
    <WorkstationToolbarTooltip label={resolvedLabel} position="bottom-end">
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        className={className}
        icon={<Chrome size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />}
        aria-label={resolvedLabel}
        data-testid={dataTestId}
        onClick={handleClick}
      />
    </WorkstationToolbarTooltip>
  );
});

ExternalBrowserButton.displayName = "ExternalBrowserButton";

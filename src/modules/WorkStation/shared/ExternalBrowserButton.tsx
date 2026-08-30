import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button, { type ButtonProps } from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { HugeiconsIcon, InternetIcon } from "@src/icons";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

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
    <ToolbarTooltip label={resolvedLabel} position="bottom-end">
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        className={className}
        icon={
          <HugeiconsIcon
            icon={InternetIcon}
            data-icon="chrome"
            size={HEADER_ICON_SIZE.sm}
            strokeWidth={1.75}
          />
        }
        aria-label={resolvedLabel}
        data-testid={dataTestId}
        onClick={handleClick}
      />
    </ToolbarTooltip>
  );
});

ExternalBrowserButton.displayName = "ExternalBrowserButton";

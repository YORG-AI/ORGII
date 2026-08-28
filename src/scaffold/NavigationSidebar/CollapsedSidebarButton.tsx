import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { getCollapsedSidebarButtonLeft } from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { HugeiconsIcon, PanelLeftIcon } from "@src/icons";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";

const CollapsedSidebarButtonComponent: React.FC = () => {
  const { t } = useTranslation("sessions");
  const collapsed = useAtomValue(sidebarCollapsedAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const label = t("common:tooltips.showSidebar");
  const shortcut = getShortcutKeys("toggle_sidebar");
  const tooltipContent = (
    <KeyboardShortcutTooltipContent label={label} shortcut={shortcut} />
  );

  const handleClick = useCallback(() => {
    setSidebarCollapsed(false);
  }, [setSidebarCollapsed]);

  if (!collapsed) return null;

  return (
    <div
      className="absolute z-20 flex -translate-y-1/2 items-center"
      data-collapsed-sidebar-button
      style={
        {
          left: getCollapsedSidebarButtonLeft(),
          top: "calc(50% + 4px)",
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties & { WebkitAppRegion: string }
      }
    >
      <Tooltip
        content={tooltipContent}
        position="bottom"
        mouseEnterDelay={200}
        framedPanel
      >
        <span className="inline-flex">
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={handleClick}
            title={label}
            aria-label={label}
            icon={
              <HugeiconsIcon
                icon={PanelLeftIcon}
                data-icon="panel-left"
                size={16}
                strokeWidth={2}
              />
            }
          />
        </span>
      </Tooltip>
    </div>
  );
};

export const CollapsedSidebarButton = memo(CollapsedSidebarButtonComponent);
CollapsedSidebarButton.displayName = "CollapsedSidebarButton";

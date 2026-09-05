import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import SessionHistoryNav from "@src/components/SessionHistoryNav";
import Tooltip from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  COLLAPSED_SIDEBAR_CHROME_CENTER_TOP,
  getCollapsedSidebarButtonLeft,
} from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { HugeiconsIcon, LayoutAlignLeftIcon, PanelLeftIcon } from "@src/icons";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";
import { isMacOS } from "@src/util/platform/tauri";

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

  // On macOS the group is drawn once, pinned in window space by
  // `PinnedSidebarChrome`; hosts only reserve the space under it.
  if (!collapsed || isMacOS()) return null;

  // Back / Forward ride along so they hold the spot they had in the sidebar
  // header; `getCollapsedSidebarChromeOffset` reserves room for both.
  return (
    <div
      className="absolute z-20 flex -translate-y-1/2 items-center gap-px"
      data-collapsed-sidebar-button
      style={
        {
          left: getCollapsedSidebarButtonLeft(),
          top: COLLAPSED_SIDEBAR_CHROME_CENTER_TOP,
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
            className="group/collapsed-sidebar"
            onClick={handleClick}
            title={label}
            aria-label={label}
            icon={
              <>
                <HugeiconsIcon
                  icon={LayoutAlignLeftIcon}
                  data-icon="layout-align-left"
                  size={16}
                  strokeWidth={2}
                  className="group-hover/collapsed-sidebar:hidden"
                />
                <HugeiconsIcon
                  icon={PanelLeftIcon}
                  data-icon="panel-left"
                  size={16}
                  strokeWidth={2}
                  className="hidden group-hover/collapsed-sidebar:block"
                />
              </>
            }
          />
        </span>
      </Tooltip>
      <SessionHistoryNav variant="chat" />
    </div>
  );
};

export const CollapsedSidebarButton = memo(CollapsedSidebarButtonComponent);
CollapsedSidebarButton.displayName = "CollapsedSidebarButton";

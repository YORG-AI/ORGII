import {
  CircleHelp,
  ListChecks,
  MessageSquarePlus,
  PlayCircle,
  Users,
} from "lucide-react";
import React, { type FC, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DropdownItem, DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import IconButton from "@src/components/IconButton";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";

interface SidebarGuideButtonProps {
  onStartSession: () => void;
  onSetUpTeam: () => void;
  onManageWork: () => void;
  onOpenTutorials: () => void;
}

/**
 * Persistent entry point for optional product guidance.
 *
 * This component owns only the floating-menu lifecycle. Product navigation
 * remains with the sidebar connector so every action continues through the
 * same command/state owner as its primary UI entry point.
 */
const SidebarGuideButton: FC<SidebarGuideButtonProps> = ({
  onStartSession,
  onSetUpTeam,
  onManageWork,
  onOpenTutorials,
}) => {
  const { t } = useTranslation("navigation");
  const {
    isOpen,
    isPositioned,
    toggle,
    close,
    triggerRef,
    panelRef,
    panelPosition,
  } = useDropdownEngine<HTMLDivElement>({
    placement: "bottom",
    align: "left",
    gap: DROPDOWN_PANEL.triggerGap,
    captureKeyboardFocus: true,
  });

  const runAction = useCallback(
    (action: () => void) => {
      close();
      action();
    },
    [close]
  );

  return (
    <>
      <WorkstationToolbarTooltip
        label={t("sidebar.guide.trigger")}
        position="bottom"
        disabled={isOpen}
      >
        <div ref={triggerRef} className="inline-flex">
          <IconButton
            aria-label={t("sidebar.guide.trigger")}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            data-testid="sidebar-guide-trigger"
            size="lg"
            variant={isOpen ? "active" : "default"}
            onClick={toggle}
          >
            <CircleHelp size={HEADER_ICON_SIZE.md} />
          </IconButton>
        </div>
      </WorkstationToolbarTooltip>

      {isOpen &&
        isPositioned &&
        createPortal(
          <DropdownPanel
            ref={panelRef}
            className={`${DROPDOWN_WIDTHS.panelWidthClass} fixed`}
            maxHeight="none"
            role="menu"
            aria-label={t("sidebar.guide.title")}
            data-testid="sidebar-guide-panel"
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left: panelPosition.left,
            }}
          >
            <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
              <div className={DROPDOWN_CLASSES.sectionLabel}>
                {t("sidebar.guide.title")}
              </div>
              <DropdownItem
                icon={
                  <MessageSquarePlus
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={2}
                  />
                }
                role="menuitem"
                tabIndex={0}
                fullWidth
                onClick={() => runAction(onStartSession)}
              >
                {t("sidebar.guide.startSession")}
              </DropdownItem>
              <DropdownItem
                icon={<Users size={DROPDOWN_ITEM.iconSize} strokeWidth={2} />}
                role="menuitem"
                tabIndex={0}
                fullWidth
                onClick={() => runAction(onSetUpTeam)}
              >
                {t("sidebar.guide.setUpTeam")}
              </DropdownItem>
              <DropdownItem
                icon={
                  <ListChecks size={DROPDOWN_ITEM.iconSize} strokeWidth={2} />
                }
                role="menuitem"
                tabIndex={0}
                fullWidth
                onClick={() => runAction(onManageWork)}
              >
                {t("sidebar.guide.manageWork")}
              </DropdownItem>
              <div className={DROPDOWN_CLASSES.menuSeparator} />
              <DropdownItem
                icon={
                  <PlayCircle size={DROPDOWN_ITEM.iconSize} strokeWidth={2} />
                }
                role="menuitem"
                tabIndex={0}
                fullWidth
                onClick={() => runAction(onOpenTutorials)}
              >
                {t("sidebar.guide.openTutorials")}
              </DropdownItem>
            </div>
          </DropdownPanel>,
          document.body
        )}
    </>
  );
};

export default SidebarGuideButton;

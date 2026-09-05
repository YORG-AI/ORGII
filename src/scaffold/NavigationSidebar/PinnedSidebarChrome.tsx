/**
 * PinnedSidebarChrome
 *
 * macOS only. The Back / Forward pair and the sidebar toggle, pinned in
 * window coordinates right after the traffic lights. Neither the sidebar
 * (which animates its width and clips its header) nor the content pane
 * (which slides as the sidebar resizes) owns the group, so it holds still
 * while everything around it moves — the sidebar header and every
 * collapsed-sidebar host merely reserve the space underneath it.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import SessionHistoryNav from "@src/components/SessionHistoryNav";
import Tooltip from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  COLLAPSED_SIDEBAR_CHROME_CENTER_TOP,
  getCollapsedSidebarButtonLeft,
} from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import {
  Cancel01Icon,
  HugeiconsIcon,
  type IconSvgElement,
  LayoutAlignLeftIcon,
  PanelLeftIcon,
} from "@src/icons";
import { hoverSidebarOpenAtom } from "@src/store/ui/hoverSidebarAtom";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";
import { isMacOS } from "@src/util/platform/tauri";

const BUTTON_CLASS =
  "group/toggle flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[100px] border-none bg-transparent p-0 text-text-2 transition-colors duration-150 hover:bg-sidebar-selected";

interface ChromeButtonProps {
  label: string;
  shortcut?: string;
  onClick: () => void;
  testId: string;
  icon: IconSvgElement;
  dataIcon: string;
  /** Second glyph swapped in on hover, without a cross-fade. */
  hoverIcon?: IconSvgElement;
  hoverDataIcon?: string;
}

const ChromeButton: React.FC<ChromeButtonProps> = ({
  label,
  shortcut,
  onClick,
  testId,
  icon,
  dataIcon,
  hoverIcon,
  hoverDataIcon,
}) => (
  <Tooltip
    content={
      <KeyboardShortcutTooltipContent
        label={label}
        shortcut={shortcut}
        noShortcut={!shortcut}
      />
    }
    position="bottom"
    mouseEnterDelay={200}
    framedPanel
  >
    <span className="inline-flex">
      <button
        type="button"
        className={BUTTON_CLASS}
        onClick={onClick}
        aria-label={label}
        data-testid={testId}
      >
        <span className="flex h-4 w-4 items-center justify-center">
          <HugeiconsIcon
            icon={icon}
            data-icon={dataIcon}
            size={16}
            strokeWidth={2}
            className={hoverIcon ? "group-hover/toggle:hidden" : undefined}
          />
          {hoverIcon ? (
            <HugeiconsIcon
              icon={hoverIcon}
              data-icon={hoverDataIcon}
              size={16}
              strokeWidth={2}
              className="hidden group-hover/toggle:block"
            />
          ) : null}
        </span>
      </button>
    </span>
  </Tooltip>
);

const PinnedSidebarChromeComponent: React.FC = () => {
  const { t } = useTranslation("sessions");
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const hoverOpen = useAtomValue(hoverSidebarOpenAtom);
  const setHoverOpen = useSetAtom(hoverSidebarOpenAtom);
  const shortcut = getShortcutKeys("toggle_sidebar");

  const hide = useCallback(() => setCollapsed(true), [setCollapsed]);
  const show = useCallback(() => setCollapsed(false), [setCollapsed]);
  const expandFromHover = useCallback(() => {
    setHoverOpen(false);
    setCollapsed(false);
  }, [setCollapsed, setHoverOpen]);
  const closeHover = useCallback(() => setHoverOpen(false), [setHoverOpen]);

  if (!isMacOS()) return null;

  let toggle: React.ReactNode;
  if (collapsed && hoverOpen) {
    toggle = (
      <>
        <ChromeButton
          label={t("common:tooltips.showSidebar")}
          shortcut={shortcut}
          onClick={expandFromHover}
          testId="pinned-sidebar-chrome-expand"
          icon={PanelLeftIcon}
          dataIcon="panel-left"
        />
        <ChromeButton
          label={t("common:actions.close")}
          onClick={closeHover}
          testId="pinned-sidebar-chrome-close-hover"
          icon={Cancel01Icon}
          dataIcon="x"
        />
      </>
    );
  } else if (collapsed) {
    toggle = (
      <ChromeButton
        label={t("common:tooltips.showSidebar")}
        shortcut={shortcut}
        onClick={show}
        testId="pinned-sidebar-chrome-show"
        icon={LayoutAlignLeftIcon}
        dataIcon="layout-align-left"
        hoverIcon={PanelLeftIcon}
        hoverDataIcon="panel-left"
      />
    );
  } else {
    toggle = (
      <ChromeButton
        label={t("common:tooltips.hideSidebar")}
        shortcut={shortcut}
        onClick={hide}
        testId="pinned-sidebar-chrome-hide"
        icon={PanelLeftIcon}
        dataIcon="panel-left"
        hoverIcon={LayoutAlignLeftIcon}
        hoverDataIcon="layout-align-left"
      />
    );
  }

  return (
    <div
      className="fixed z-[10000] flex -translate-y-1/2 items-center gap-1"
      data-testid="pinned-sidebar-chrome"
      style={
        {
          left: getCollapsedSidebarButtonLeft(),
          top: COLLAPSED_SIDEBAR_CHROME_CENTER_TOP,
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties
      }
    >
      <SessionHistoryNav />
      {toggle}
    </div>
  );
};

export const PinnedSidebarChrome = memo(PinnedSidebarChromeComponent);
PinnedSidebarChrome.displayName = "PinnedSidebarChrome";

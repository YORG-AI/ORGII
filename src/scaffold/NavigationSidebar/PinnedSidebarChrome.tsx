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

import SessionHistoryNav, {
  type SessionHistoryNavVariant,
} from "@src/components/SessionHistoryNav";
import SidebarChromeIconButton from "@src/components/SidebarChromeIconButton";
import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
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

interface ChromeButtonProps {
  variant: SessionHistoryNavVariant;
  label: string;
  shortcutId?: string;
  onClick: () => void;
  testId: string;
  icon: IconSvgElement;
  dataIcon: string;
  /** Second glyph swapped in on hover, without a cross-fade. */
  hoverIcon?: IconSvgElement;
  hoverDataIcon?: string;
}

const ChromeButton: React.FC<ChromeButtonProps> = ({
  variant,
  label,
  shortcutId,
  onClick,
  testId,
  icon,
  dataIcon,
  hoverIcon,
  hoverDataIcon,
}) => {
  const glyphs = (
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
  );
  if (variant === "sidebar") {
    return (
      <SidebarChromeIconButton
        title={label}
        shortcutId={shortcutId}
        onClick={onClick}
        className="group/toggle"
        data-testid={testId}
      >
        {glyphs}
      </SidebarChromeIconButton>
    );
  }
  return (
    <TabBarTrailingIconButton
      title={label}
      shortcutId={shortcutId}
      tooltipPosition="bottom"
      nativeTitle={false}
      onClick={onClick}
      className="group/toggle"
      data-testid={testId}
    >
      {glyphs}
    </TabBarTrailingIconButton>
  );
};

const PinnedSidebarChromeComponent: React.FC = () => {
  const { t } = useTranslation("sessions");
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const hoverOpen = useAtomValue(hoverSidebarOpenAtom);
  const setHoverOpen = useSetAtom(hoverSidebarOpenAtom);

  const hide = useCallback(() => setCollapsed(true), [setCollapsed]);
  const show = useCallback(() => setCollapsed(false), [setCollapsed]);
  const expandFromHover = useCallback(() => {
    setHoverOpen(false);
    setCollapsed(false);
  }, [setCollapsed, setHoverOpen]);
  const closeHover = useCallback(() => setHoverOpen(false), [setHoverOpen]);

  if (!isMacOS()) return null;

  // Whichever surface is under the group lends its tokens: the sidebar while
  // it is open (or peeking in as the hover sidebar), the chat pane otherwise.
  const variant: SessionHistoryNavVariant =
    !collapsed || hoverOpen ? "sidebar" : "chat";

  let toggle: React.ReactNode;
  if (collapsed && hoverOpen) {
    toggle = (
      <>
        <ChromeButton
          variant={variant}
          label={t("common:tooltips.showSidebar")}
          shortcutId="toggle_sidebar"
          onClick={expandFromHover}
          testId="pinned-sidebar-chrome-expand"
          icon={PanelLeftIcon}
          dataIcon="panel-left"
        />
        <ChromeButton
          variant={variant}
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
        variant={variant}
        label={t("common:tooltips.showSidebar")}
        shortcutId="toggle_sidebar"
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
        variant={variant}
        label={t("common:tooltips.hideSidebar")}
        shortcutId="toggle_sidebar"
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
      className="fixed z-[10000] flex -translate-y-1/2 items-center gap-px"
      data-testid="pinned-sidebar-chrome"
      data-variant={variant}
      style={
        {
          left: getCollapsedSidebarButtonLeft(),
          top: COLLAPSED_SIDEBAR_CHROME_CENTER_TOP,
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties
      }
    >
      {toggle}
      <SessionHistoryNav variant={variant} />
    </div>
  );
};

export const PinnedSidebarChrome = memo(PinnedSidebarChromeComponent);
PinnedSidebarChrome.displayName = "PinnedSidebarChrome";

/**
 * ChatPanelPlusMenu — the "+" button and its dropdown, placed in the chat
 * panel header toolbar (left of the "..." menu).
 */
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Dropdown from "@src/components/Dropdown";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import {
  Add01Icon,
  Briefcase02Icon,
  DeliveryBox01Icon,
  GaugeIcon,
  HugeiconsIcon,
  KanbanIcon,
  MessageAdd02Icon,
  PictureInPicture01Icon,
} from "@src/icons";
import { isMacOS } from "@src/util/platform/tauri";

import { CHAT_PANEL_HEADER_NO_DRAG_STYLE } from "../header";

// ─── Plus-menu dropdown ───────────────────────────────────────────────────────

interface PlusMenuContentProps {
  onOpenLaunchpad: () => void;
  onOpenKanban: () => void;
  onOpenRuntime: () => void;
  onNewProject: () => void;
  onNewWorkItem: () => void;
  onOpenSideChat: () => void;
  onClose: () => void;
}

export function PlusMenuContent({
  onOpenLaunchpad,
  onOpenKanban,
  onOpenRuntime,
  onNewProject,
  onNewWorkItem,
  onOpenSideChat,
  onClose,
}: PlusMenuContentProps) {
  const { t } = useTranslation(["sessions", "navigation"]);
  const MOD = isMacOS() ? "⌘" : "Ctrl";

  // New session opens the singleton start page. It carries the ⌘N hint since
  // that shortcut (handled in ChatPanelTabBar) opens the same surface.
  const items = [
    {
      id: "launchpad",
      icon: (
        <HugeiconsIcon
          icon={MessageAdd02Icon}
          data-icon="message-add"
          size={HEADER_ICON_SIZE.sm}
          strokeWidth={1.8}
        />
      ),
      label: t("sessions:chat.startPage.newSession.title"),
      hint: `${MOD}N`,
      onClick: onOpenLaunchpad,
    },
    {
      id: "work-management",
      icon: (
        <HugeiconsIcon
          icon={KanbanIcon}
          data-icon="kanban"
          size={HEADER_ICON_SIZE.sm}
          strokeWidth={1.8}
        />
      ),
      label: t("sessions:simulator.tabs.kanban"),
      onClick: onOpenKanban,
    },
    {
      id: "runtime",
      icon: (
        <HugeiconsIcon
          icon={GaugeIcon}
          data-icon="gauge"
          size={HEADER_ICON_SIZE.sm}
          strokeWidth={1.8}
        />
      ),
      label: t("sessions:chat.startPage.tabs.runtime"),
      onClick: onOpenRuntime,
    },
    {
      id: "new-project",
      icon: (
        <HugeiconsIcon
          icon={DeliveryBox01Icon}
          data-icon="box"
          size={HEADER_ICON_SIZE.sm}
          strokeWidth={1.8}
        />
      ),
      label: t("sessions:creator.createTarget.project"),
      onClick: onNewProject,
    },
    {
      id: "new-work-item",
      icon: (
        <HugeiconsIcon
          icon={Briefcase02Icon}
          data-icon="briefcase-business"
          size={HEADER_ICON_SIZE.sm}
          strokeWidth={1.8}
        />
      ),
      label: t("chat.startPage.newWorkItem.title"),
      onClick: onNewWorkItem,
    },
    {
      id: "side-chat",
      icon: (
        <HugeiconsIcon
          icon={PictureInPicture01Icon}
          data-icon="picture-in-picture-2"
          size={HEADER_ICON_SIZE.sm}
          strokeWidth={1.8}
        />
      ),
      label: t("sessions:chat.sideChat.title"),
      onClick: onOpenSideChat,
    },
  ] as const;

  return (
    <div
      className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.wideMenuClass}`}
    >
      <div className={DROPDOWN_CLASSES.itemsColumn}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`${DROPDOWN_CLASSES.menuActionItem} justify-between`}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {item.icon}
              <span className="truncate">{item.label}</span>
            </span>
            {"hint" in item && item.hint ? (
              <span className="ml-4 shrink-0 text-[11px] text-text-3">
                {item.hint}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Exported + menu button (placed in header toolbar, left of ...) ───────────

export interface ChatPanelPlusMenuProps {
  onOpenLaunchpad: () => void;
  onOpenKanban: () => void;
  onOpenRuntime: () => void;
  onNewProject: () => void;
  onNewWorkItem: () => void;
  onOpenSideChat: () => void;
}

export function ChatPanelPlusMenu({
  onOpenLaunchpad,
  onOpenKanban,
  onOpenRuntime,
  onNewProject,
  onNewWorkItem,
  onOpenSideChat,
}: ChatPanelPlusMenuProps): React.ReactNode {
  const { t } = useTranslation("sessions");
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const plusLabel = t("chat.tabs.newTab", "New tab");

  return (
    <Dropdown
      droplist={
        <PlusMenuContent
          onOpenLaunchpad={onOpenLaunchpad}
          onOpenKanban={onOpenKanban}
          onOpenRuntime={onOpenRuntime}
          onNewProject={onNewProject}
          onNewWorkItem={onNewWorkItem}
          onOpenSideChat={onOpenSideChat}
          onClose={closeMenu}
        />
      }
      position="bottom-end"
      trigger="click"
      popupVisible={menuOpen}
      onVisibleChange={setMenuOpen}
      getPopupContainer={() => document.body}
      avoidViewportOverflow
    >
      <span
        className="inline-flex shrink-0"
        style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
      >
        <TabBarTrailingIconButton
          title={plusLabel}
          active={menuOpen}
          tooltipDisabled
          nativeTitle={false}
        >
          <HugeiconsIcon
            icon={Add01Icon}
            data-icon="plus"
            size={HEADER_ICON_SIZE.md}
            strokeWidth={2}
          />
        </TabBarTrailingIconButton>
      </span>
    </Dropdown>
  );
}

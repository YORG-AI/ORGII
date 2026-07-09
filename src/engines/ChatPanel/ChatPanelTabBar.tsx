/**
 * ChatPanelTabBar
 *
 * Inline tab-pill strip rendered inside the existing ChatPanelHeader row,
 * replacing the title/drag-spacer area. Uses the exact same primitives as
 * the Workstation tab bar:
 *   - WorkStationTabPillSurface  (active/inactive pill surface)
 *   - TabPillCloseButton         (14px X close control)
 *   - TabLabelRowScrim           (gradient scrim behind close button)
 *   - TabBarTrailingIconButton   (+ button)
 *   - TAB_PAIR_SEPARATOR_SLOT_CLASS between pills
 *
 * Keyboard shortcuts (only when focus is inside the chat panel container):
 *   Cmd+W  — close active tab
 *   Cmd+]  — next tab    Cmd+[  — prev tab
 *   Cmd+N  — new session tab
 *   Cmd+T  — new terminal tab (via global "create-chat-tab" event)
 */
import { useAtomValue, useSetAtom } from "jotai";
import {
  BriefcaseBusiness,
  KeyRound,
  ListTodo,
  MessageSquarePlus,
  Plus,
  TerminalSquare,
} from "lucide-react";
import React, {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Dropdown from "@src/components/Dropdown";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import SessionHoverCard from "@src/components/SessionHoverCard";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { TERMINAL_AGENT_STATUS } from "@src/engines/TerminalCore/types";
import { TabBarTrailingIconButton } from "@src/modules/WorkStation/shared/TabBar/components/TabBarTrailingIconButton";
import { TabLabelRowScrim } from "@src/modules/WorkStation/shared/TabBar/components/TabLabelRowScrim";
import { TabPillCloseButton } from "@src/modules/WorkStation/shared/TabBar/components/TabPillCloseButton";
import { WorkStationTabPillSurface } from "@src/modules/WorkStation/shared/TabBar/components/WorkStationTabPillSurface";
import { TAB_PAIR_SEPARATOR_SLOT_CLASS } from "@src/modules/WorkStation/shared/TabBar/config";
import {
  type ChatPanelTab,
  activateChatPanelTabAtom,
  chatPanelTabsAtom,
  closeAndDestroyChatPanelTabAtom,
  nextChatPanelTabAtom,
  prevChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { terminalSessionsAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import { sessionByIdAtom } from "@src/store/session";
import { isWindows } from "@src/util/platform/tauri";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

import {
  CHAT_PANEL_HEADER_DRAG_STYLE,
  CHAT_PANEL_HEADER_NO_DRAG_STYLE,
  chatPanelHeaderSlotsAtom,
} from "./header";

// ─── Constants ────────────────────────────────────────────────────────────────

const isMac = !isWindows();

const TERMINAL_AGENT_STATUS_DOT_CLASS = {
  [TERMINAL_AGENT_STATUS.STARTING]: "bg-warning-6",
  [TERMINAL_AGENT_STATUS.RUNNING]: "bg-success-6",
  [TERMINAL_AGENT_STATUS.WAITING]: "bg-warning-6",
  [TERMINAL_AGENT_STATUS.DONE]: "bg-fill-4",
} as const;

// ─── TabPill ──────────────────────────────────────────────────────────────────

interface TabPillProps {
  tab: ChatPanelTab;
  isActive: boolean;
  titleOverride?: string;
  iconOverride?: React.ReactNode;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

const TabPill = memo(function TabPill({
  tab,
  isActive,
  titleOverride,
  iconOverride,
  onActivate,
  onClose,
}: TabPillProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const showCloseSlot = tab.closable && hovered;

  // Read session data for icon + hover card (session tabs only)
  const session = useAtomValue(sessionByIdAtom(tab.sessionId ?? ""));
  const terminalSessions = useAtomValue(terminalSessionsAtom);
  const terminalSession =
    tab.type === "terminal"
      ? terminalSessions.find(
          (candidate) => candidate.id === tab.terminalSessionId
        )
      : undefined;
  const agentStatus = terminalSession?.agentStatus;

  const iconColorClass = isActive ? "text-primary-6" : "text-text-2";

  let icon: React.ReactNode;
  if (iconOverride) {
    icon = <span className={`shrink-0 ${iconColorClass}`}>{iconOverride}</span>;
  } else if (tab.type === "terminal") {
    icon = (
      <TerminalSquare
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (session) {
    // Use the same icon resolution as the session sidebar.
    // React.createElement avoids the static-components lint rule —
    // resolveSessionRowIcon returns a stable LucideIcon reference, not a
    // newly created component function.
    icon = React.createElement(resolveSessionRowIcon(session), {
      size: 16,
      strokeWidth: 2,
      className: `shrink-0 ${iconColorClass}`,
    });
  } else {
    icon = (
      <MessageSquarePlus
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  }

  const displayTitle = titleOverride ?? tab.title;

  const pill = (
    <WorkStationTabPillSurface
      as="button"
      isActive={isActive}
      variant="session"
      role="tab"
      aria-selected={isActive}
      title={displayTitle}
      onClick={() => onActivate(tab.id)}
      onAuxClick={(evt) => {
        if (evt.button === 1 && tab.closable) onClose(tab.id);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
    >
      <div className="flex shrink-0 items-center justify-center">{icon}</div>
      <div className="relative flex min-w-0 flex-1 items-center overflow-hidden">
        <span
          className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] ${
            isActive ? "text-primary-6" : "text-text-2"
          }`}
        >
          {displayTitle}
        </span>
        {agentStatus && (
          <span
            aria-hidden="true"
            className={`ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TERMINAL_AGENT_STATUS_DOT_CLASS[agentStatus]}`}
          />
        )}
        <TabLabelRowScrim visible={showCloseSlot} />
      </div>
      {tab.closable && (
        <TabPillCloseButton
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          title={t("actions.close")}
          showX={hovered}
          className={`grid place-items-center rounded text-text-3 transition-[opacity,colors,background-color] duration-150 ${SURFACE_TOKENS.hover} absolute right-1 top-1/2 z-10 h-5 w-5 -translate-y-1/2 hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-6 focus-visible:ring-offset-0 ${
            showCloseSlot
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0"
          }`}
        />
      )}
    </WorkStationTabPillSurface>
  );

  // Session tabs with an active session get the hover card
  if (tab.type === "session" && tab.sessionId) {
    return (
      <SessionHoverCard sessionId={tab.sessionId} position="bottom-start">
        {pill}
      </SessionHoverCard>
    );
  }

  return pill;
});

// ─── Plus-menu dropdown ───────────────────────────────────────────────────────

interface PlusMenuContentProps {
  onNewSession: () => void;
  onNewWorkItem: () => void;
  onManageIssues: () => void;
  onAddApiKey: () => void;
  onClose: () => void;
}

function PlusMenuContent({
  onNewSession,
  onNewWorkItem,
  onManageIssues,
  onAddApiKey,
  onClose,
}: PlusMenuContentProps) {
  const { t } = useTranslation("sessions");
  const MOD = isMac ? "⌘" : "Ctrl";

  const items = [
    {
      id: "new-session",
      icon: <MessageSquarePlus size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("chat.startPage.newSession.title"),
      hint: `${MOD}N`,
      onClick: onNewSession,
    },
    {
      id: "new-work-item",
      icon: <BriefcaseBusiness size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("chat.startPage.newWorkItem.title"),
      onClick: onNewWorkItem,
    },
    {
      id: "manage-issues",
      icon: <ListTodo size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("chat.startPage.manageIssues.title"),
      onClick: onManageIssues,
    },
    {
      id: "add-api-key",
      icon: <KeyRound size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("chat.startPage.addApiKey.title"),
      onClick: onAddApiKey,
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
  onNewSession: () => void;
  onNewWorkItem: () => void;
  onManageIssues: () => void;
  onAddApiKey: () => void;
}

export function ChatPanelPlusMenu({
  onNewSession,
  onNewWorkItem,
  onManageIssues,
  onAddApiKey,
}: ChatPanelPlusMenuProps): React.ReactNode {
  const { t } = useTranslation("sessions");
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const plusLabel = t("chat.tabs.newTab", "New tab");

  return (
    <Dropdown
      droplist={
        <PlusMenuContent
          onNewSession={onNewSession}
          onNewWorkItem={onNewWorkItem}
          onManageIssues={onManageIssues}
          onAddApiKey={onAddApiKey}
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
        <TabBarTrailingIconButton title={plusLabel} active={menuOpen}>
          <Plus size={HEADER_ICON_SIZE.md} strokeWidth={2} />
        </TabBarTrailingIconButton>
      </span>
    </Dropdown>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export interface ChatPanelTabBarProps {
  onNewSession: () => void;
  onNewTerminal: () => void;
  /** Ref to the outermost chat panel container for focus-scoped keyboard handling */
  containerRef?: React.RefObject<HTMLElement | null>;
}

export function ChatPanelTabBar({
  onNewSession,
  onNewTerminal,
  containerRef,
}: ChatPanelTabBarProps): React.ReactNode {
  const state = useAtomValue(chatPanelTabsAtom);
  const headerSlots = useAtomValue(chatPanelHeaderSlotsAtom);
  const activateTab = useSetAtom(activateChatPanelTabAtom);
  const closeTab = useSetAtom(closeAndDestroyChatPanelTabAtom);
  const nextTab = useSetAtom(nextChatPanelTabAtom);
  const prevTab = useSetAtom(prevChatPanelTabAtom);

  const tabsRef = useRef(state);
  useEffect(() => {
    tabsRef.current = state;
  }, [state]);

  const handleKeyDown = useCallback(
    (evt: KeyboardEvent) => {
      if (
        containerRef?.current &&
        !containerRef.current.contains(document.activeElement)
      )
        return;

      const mod = isMac ? evt.metaKey : evt.ctrlKey;
      if (!mod) return;

      if (evt.key === "w" && !evt.shiftKey) {
        const active = tabsRef.current.tabs.find(
          (tab) => tab.id === tabsRef.current.activeTabId
        );
        if (active?.closable) {
          evt.preventDefault();
          void closeTab(active.id);
        }
        return;
      }
      if (evt.key === "]") {
        evt.preventDefault();
        nextTab();
        return;
      }
      if (evt.key === "[") {
        evt.preventDefault();
        prevTab();
        return;
      }
      if (evt.key === "n" && !evt.shiftKey) {
        evt.preventDefault();
        onNewSession();
        return;
      }
    },
    [closeTab, nextTab, prevTab, onNewSession, containerRef]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    const handler = () => onNewTerminal();
    window.addEventListener("create-chat-tab", handler);
    return () => window.removeEventListener("create-chat-tab", handler);
  }, [onNewTerminal]);

  // Inline strip — no outer wrapper, fills the flex row in the header
  return (
    <div
      className="flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden scrollbar-hide"
      data-tauri-drag-region
      style={CHAT_PANEL_HEADER_DRAG_STYLE}
    >
      <span
        className={`${TAB_PAIR_SEPARATOR_SLOT_CLASS} bg-transparent`}
        aria-hidden
        data-tauri-drag-region
        style={CHAT_PANEL_HEADER_DRAG_STYLE}
      />

      {state.tabs.map((tab, i) => {
        const next = state.tabs[i + 1];
        const isActive = tab.id === state.activeTabId;
        const nextIsActive = next?.id === state.activeTabId;
        const separatorVisible = !!next && !isActive && !nextIsActive;

        return (
          <Fragment key={tab.id}>
            <TabPill
              tab={tab}
              isActive={isActive}
              titleOverride={isActive ? headerSlots?.tabTitle : undefined}
              iconOverride={isActive ? headerSlots?.tabIcon : undefined}
              onActivate={activateTab}
              onClose={closeTab}
            />
            {next && (
              <span
                className={`${TAB_PAIR_SEPARATOR_SLOT_CLASS} ${
                  separatorVisible ? "bg-border-2" : "bg-transparent"
                }`}
                aria-hidden
                data-tauri-drag-region
                style={CHAT_PANEL_HEADER_DRAG_STYLE}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

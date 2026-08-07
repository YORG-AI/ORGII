/**
 * ChatPanelTabBar
 *
 * Inline tab-pill strip rendered inside the existing ChatPanelHeader row,
 * replacing the title/drag-spacer area. Only shown on the start page —
 * session/terminal views keep a plain header. Uses the exact same
 * primitives as the Workstation tab bar:
 *   - WorkStationTabPillSurface  (active/inactive pill surface)
 *   - TabPillCloseButton         (14px X close control)
 *   - TabLabelRowScrim           (gradient scrim behind close button)
 *   - TabBarTrailingIconButton   (+ button)
 *   - TAB_PAIR_SEPARATOR_SLOT_CLASS between pills
 *
 * Keyboard shortcuts live in useChatPanelTabShortcuts (mounted by ChatPanel
 * itself, not this strip, so they keep working while the strip is hidden):
 *   Cmd+W  — close active tab
 *   Cmd+]  — next tab    Cmd+[  — prev tab
 *   Cmd+N  — new session tab
 *   Cmd+T  — new terminal tab (via global "create-chat-tab" event)
 */
import { useAtomValue, useSetAtom } from "jotai";
import {
  Boxes,
  BriefcaseBusiness,
  CircleDot,
  Columns3,
  GitPullRequest,
  Info,
  LayoutGrid,
  MessageSquarePlus,
  Plus,
  Settings2,
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
import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation";
import { isWindows } from "@src/util/platform/tauri";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

import { resolveChatPanelTabDisplayTitle } from "./chatPanelTabDisplay";
import {
  CHAT_PANEL_HEADER_DRAG_STYLE,
  CHAT_PANEL_HEADER_NO_DRAG_STYLE,
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
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

const TabPill = memo(function TabPill({
  tab,
  isActive,
  onActivate,
  onClose,
}: TabPillProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const showCloseSlot = hovered;

  // When this tab becomes active (e.g. via a sidebar click), reveal it in the
  // horizontally-scrollable tab strip. `nearest` only scrolls when off-screen.
  const pillRef = useRef<HTMLButtonElement | HTMLDivElement>(null);
  useEffect(() => {
    if (isActive) {
      pillRef.current?.scrollIntoView({
        behavior: "smooth",
        inline: "nearest",
        block: "nearest",
      });
    }
  }, [isActive]);

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

  const displayTitle = resolveChatPanelTabDisplayTitle(tab, session, {
    launchpad: t("navigation:routes.launchpad"),
    cloudOrg: t("navigation:collaboration.manageOrg"),
    workManagement: {
      kanban: t("sessions:simulator.tabs.kanban"),
      projects: t("navigation:labels.projects"),
      githubIssues: t("sessions:kanban.sidebar.githubIssues"),
      githubPrs: t("sessions:kanban.sidebar.githubPrs"),
    },
    sessionFallback: t("chat.defaultTitle"),
  });

  const iconColorClass = isActive ? "text-primary-6" : "text-text-2";

  let icon: React.ReactNode;
  if (tab.type === "terminal") {
    icon = (
      <TerminalSquare
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "start-page") {
    icon = (
      <LayoutGrid
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "workspace") {
    icon = (
      <Info
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "cloud-org") {
    icon = (
      <Settings2
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "work-management") {
    const WorkManagementIcon =
      tab.managementSection === WORK_MANAGEMENT_SECTION.PROJECTS
        ? Boxes
        : tab.managementSection === WORK_MANAGEMENT_SECTION.GITHUB_ISSUES
          ? CircleDot
          : tab.managementSection === WORK_MANAGEMENT_SECTION.GITHUB_PRS
            ? GitPullRequest
            : Columns3;
    icon = React.createElement(WorkManagementIcon, {
      size: 16,
      strokeWidth: 1.75,
      className: `shrink-0 ${iconColorClass}`,
    });
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

  const pill = (
    <WorkStationTabPillSurface
      ref={pillRef}
      isActive={isActive}
      variant="session"
      role="tab"
      aria-selected={isActive}
      title={displayTitle}
      onClick={() => onActivate(tab.id)}
      onAuxClick={(evt) => {
        if (evt.button === 1) onClose(tab.id);
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
  onOpenLaunchpad: () => void;
  onOpenKanban: () => void;
  onNewWorkItem: () => void;
  onClose: () => void;
}

function PlusMenuContent({
  onOpenLaunchpad,
  onOpenKanban,
  onNewWorkItem,
  onClose,
}: PlusMenuContentProps) {
  const { t } = useTranslation(["sessions", "navigation"]);
  const MOD = isMac ? "⌘" : "Ctrl";

  // "New session" and "Launchpad" now open the same singleton start page, so
  // only the Launchpad entry is kept. It carries the ⌘N hint since that
  // shortcut (handled in ChatPanelTabBar) opens the same start page.
  const items = [
    {
      id: "launchpad",
      icon: <LayoutGrid size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("navigation:routes.launchpad"),
      hint: `${MOD}N`,
      onClick: onOpenLaunchpad,
    },
    {
      id: "work-management",
      icon: <Columns3 size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("sessions:simulator.tabs.kanban"),
      onClick: onOpenKanban,
    },
    {
      id: "new-work-item",
      icon: <BriefcaseBusiness size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("chat.startPage.newWorkItem.title"),
      onClick: onNewWorkItem,
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
  onNewWorkItem: () => void;
}

export function ChatPanelPlusMenu({
  onOpenLaunchpad,
  onOpenKanban,
  onNewWorkItem,
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
          onNewWorkItem={onNewWorkItem}
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
          <Plus size={HEADER_ICON_SIZE.md} strokeWidth={2} />
        </TabBarTrailingIconButton>
      </span>
    </Dropdown>
  );
}

// ─── Keyboard shortcuts hook ──────────────────────────────────────────────────

export interface UseChatPanelTabShortcutsOptions {
  onNewSession: () => void;
  onNewTerminal: () => void;
  /** Ref to the outermost chat panel container for focus-scoped keyboard handling */
  containerRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Chat-panel-scoped tab shortcuts (⌘W / ⌘] / ⌘[ / ⌘N) plus the global
 * "create-chat-tab" event. Mounted by ChatPanel unconditionally so the
 * shortcuts work even when the visual tab strip is not rendered.
 */
export function useChatPanelTabShortcuts({
  onNewSession,
  onNewTerminal,
  containerRef,
}: UseChatPanelTabShortcutsOptions): void {
  const state = useAtomValue(chatPanelTabsAtom);
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
        if (active) {
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
    [closeTab, nextTab, onNewSession, prevTab, containerRef]
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
}

// ─── Main component ────────────────────────────────────────────────────────────

export function ChatPanelTabBar(): React.ReactNode {
  const state = useAtomValue(chatPanelTabsAtom);
  const activateTab = useSetAtom(activateChatPanelTabAtom);
  const closeTab = useSetAtom(closeAndDestroyChatPanelTabAtom);

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

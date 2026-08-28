/**
 * BrowserPrimarySidebar Component
 *
 * Primary sidebar for Browser tool using PrimarySidebarLayout.
 * Provides pill tabs:
 * - Sessions: Two collapsible sections (Regular Browsing / Private Browsing)
 * - Design: Two collapsible sections (Pages / Components)
 * - Settings: Browser settings
 *
 * Shares structural components with other Workstation for consistency.
 */
import type { BrowserSession } from "@/src/engines/BrowserCore/types";
import {
  PrimarySidebarLayout,
  type PrimarySidebarTab,
} from "@/src/modules/WorkStation/shared";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SectionHeaderAction } from "@src/components/TreePanelSidebar/types";
import {
  Add01Icon,
  CodeIcon,
  FilterIcon,
  HugeiconsIcon,
  InternetIcon,
  Pen01Icon,
  WorkHistoryIcon,
} from "@src/icons";

import {
  DesignTabGlobalTokens,
  getGlobalTokensActions,
} from "./tabs/DesignTab";
import HistoryTab from "./tabs/HistoryTab";
import SessionsTab from "./tabs/SessionsTab";

// ============================================
// Types
// ============================================

export interface BrowserPrimarySidebarProps {
  /** Repository path for component scanning */
  repoPath?: string;
  /** List of browser sessions */
  sessions: BrowserSession[];
  /** Currently active session ID */
  activeSessionId: string | null;
  /** Callback to set active session */
  onSelectSession: (sessionId: string) => void;
  /** Callback to create a new session */
  onNewSession: () => void;
  /** Callback to create a new private session */
  onNewPrivateSession?: () => void;
  /** Callback to close a session */
  onCloseSession: (sessionId: string) => void;
  /** Callback to open a browsing history entry (full variant only) */
  onOpenHistoryUrl?: (url: string) => void;
  /** Hide per-section new-tab actions when creation is owned by outer chrome. */
  hideNewSessionActions?: boolean;

  /** Open Color Tokens consolidated tab (full variant only) */
  onOpenColorTokens?: () => void;

  /**
   * Sessions-only variant: render just the Sessions tab (no History /
   * Design pills) and hide the pill-tab header row. The My Station browser
   * manages its webpages through the top tab bar, so it only needs the
   * session list here.
   */
  sessionsOnly?: boolean;
}

// ============================================
// Component
// ============================================

const noop = () => {};

export const BrowserPrimarySidebar: React.FC<BrowserPrimarySidebarProps> = memo(
  ({
    repoPath,
    sessions,
    activeSessionId,
    onSelectSession,
    onNewSession,
    onNewPrivateSession,
    onCloseSession,
    onOpenHistoryUrl,
    hideNewSessionActions = false,
    onOpenColorTokens,
    sessionsOnly = false,
  }) => {
    const { t } = useTranslation();

    // Active tab state
    const [activeTab, setActiveTab] = useState("sessions");

    // Filter state for design sections (follows explorer pattern)
    const [showFilterTokens, setShowFilterTokens] = useState(false);
    const [showFilterRegularSessions, setShowFilterRegularSessions] =
      useState(false);
    const [showFilterPrivateSessions, setShowFilterPrivateSessions] =
      useState(false);

    // State to store collapseAll/refresh callbacks from child components
    const [refreshTokens, setRefreshTokens] = useState<(() => void) | null>(
      null
    );

    const handleRegisterRefreshTokens = useCallback((refresh: () => void) => {
      setRefreshTokens(() => refresh);
    }, []);

    const handleRefreshTokens = useCallback(() => {
      refreshTokens?.();
    }, [refreshTokens]);

    // Handle tab change
    const handleTabChange = useCallback((tab: string) => {
      setActiveTab(tab);
    }, []);

    // Toggle filter for Global Tokens section
    const handleToggleFilterTokens = useCallback(() => {
      setShowFilterTokens((prev) => !prev);
    }, []);

    const handleToggleFilterRegularSessions = useCallback(() => {
      setShowFilterRegularSessions((prev) => !prev);
    }, []);

    const handleToggleFilterPrivateSessions = useCallback(() => {
      setShowFilterPrivateSessions((prev) => !prev);
    }, []);

    // Split sessions into regular and private
    const { regularSessions, privateSessions } = useMemo(() => {
      const regular: BrowserSession[] = [];
      const priv: BrowserSession[] = [];

      for (const session of sessions) {
        if (session.incognito) {
          priv.push(session);
        } else {
          regular.push(session);
        }
      }

      return { regularSessions: regular, privateSessions: priv };
    }, [sessions]);

    // Section header actions for regular browsing
    const regularActions: SectionHeaderAction[] = useMemo(
      () => [
        {
          key: "filter-regular-sessions",
          icon: (
            <HugeiconsIcon
              icon={FilterIcon}
              data-icon="filter-icon"
              size={14}
              className={showFilterRegularSessions ? "text-primary-6" : ""}
            />
          ),
          tooltip: t("common:actions.filter"),
          onClick: handleToggleFilterRegularSessions,
        },
        ...(!hideNewSessionActions
          ? [
              {
                key: "new-session",
                icon: (
                  <HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />
                ),
                tooltip: t("common:controlTower.sidebar.newTab"),
                onClick: onNewSession,
              },
            ]
          : []),
      ],
      [
        showFilterRegularSessions,
        handleToggleFilterRegularSessions,
        hideNewSessionActions,
        onNewSession,
        t,
      ]
    );

    // Section header actions for private browsing
    const privateActions: SectionHeaderAction[] = useMemo(
      () => [
        {
          key: "filter-private-sessions",
          icon: (
            <HugeiconsIcon
              icon={FilterIcon}
              data-icon="filter-icon"
              size={14}
              className={showFilterPrivateSessions ? "text-primary-6" : ""}
            />
          ),
          tooltip: t("common:actions.filter"),
          onClick: handleToggleFilterPrivateSessions,
        },
        ...(!hideNewSessionActions
          ? [
              {
                key: "new-private-session",
                icon: (
                  <HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />
                ),
                tooltip: t("common:controlTower.sidebar.newPrivateTab"),
                onClick: onNewPrivateSession || onNewSession,
              },
            ]
          : []),
      ],
      [
        showFilterPrivateSessions,
        handleToggleFilterPrivateSessions,
        hideNewSessionActions,
        onNewPrivateSession,
        onNewSession,
        t,
      ]
    );

    // Section header actions for Global Tokens
    const globalTokensActions: SectionHeaderAction[] = useMemo(
      () =>
        getGlobalTokensActions({
          showFilter: showFilterTokens,
          onToggleFilter: handleToggleFilterTokens,
          onRefresh: handleRefreshTokens,
        }),
      [showFilterTokens, handleToggleFilterTokens, handleRefreshTokens]
    );

    // Build tabs configuration. `sessionsOnly` (My Station) shows just the
    // session list — no History / Design pills and no pill header. The full
    // variant (SessionReplay's My Tabs sidebar) keeps all three tabs.
    const tabs: PrimarySidebarTab[] = useMemo(() => {
      const sessionsTab: PrimarySidebarTab = {
        key: "sessions",
        label: t("tabs.sessions"),
        icon: (
          <HugeiconsIcon
            icon={InternetIcon}
            data-icon="globe"
            size={16}
            strokeWidth={1.75}
          />
        ),
        sections: [
          {
            key: "regular-browsing",
            title: t("labels.regularBrowsing"),
            content: (
              <SessionsTab
                sessions={regularSessions}
                activeSessionId={activeSessionId}
                onSelectSession={onSelectSession}
                onCloseSession={onCloseSession}
                showFilter={showFilterRegularSessions}
              />
            ),
            defaultFlexGrow: 1,
            resizable: true,
            actions: regularActions,
          },
          {
            key: "private-browsing",
            title: t("labels.privateBrowsing"),
            icon: (
              <HugeiconsIcon
                icon={InternetIcon}
                data-icon="globe"
                size={14}
                strokeWidth={1.75}
              />
            ),
            content: (
              <SessionsTab
                sessions={privateSessions}
                activeSessionId={activeSessionId}
                onSelectSession={onSelectSession}
                onCloseSession={onCloseSession}
                showFilter={showFilterPrivateSessions}
              />
            ),
            defaultFlexGrow: 1,
            defaultCollapsed: true,
            resizable: true,
            actions: privateActions,
          },
        ],
      };

      if (sessionsOnly) return [sessionsTab];

      return [
        sessionsTab,
        {
          key: "history",
          label: t("tabs.history"),
          icon: (
            <HugeiconsIcon
              icon={WorkHistoryIcon}
              data-icon="history"
              size={16}
              strokeWidth={1.75}
            />
          ),
          sections: [
            {
              key: "browsing-history",
              title: t("labels.history"),
              icon: (
                <HugeiconsIcon
                  icon={WorkHistoryIcon}
                  data-icon="history"
                  size={14}
                  strokeWidth={1.75}
                />
              ),
              content: (
                <HistoryTab
                  sessions={sessions}
                  onOpenHistoryUrl={onOpenHistoryUrl ?? noop}
                />
              ),
              defaultFlexGrow: 1,
              resizable: true,
            },
          ],
        },
        {
          key: "design",
          label: t("tabs.design"),
          icon: (
            <HugeiconsIcon
              icon={Pen01Icon}
              data-icon="pencil"
              size={16}
              strokeWidth={1.75}
            />
          ),
          sections: [
            {
              key: "global-tokens",
              title: t("labels.globalTokens"),
              icon: (
                <HugeiconsIcon
                  icon={CodeIcon}
                  data-icon="code-2"
                  size={14}
                  strokeWidth={1.75}
                />
              ),
              content: (
                <DesignTabGlobalTokens
                  repoPath={repoPath}
                  showFilter={showFilterTokens}
                  onOpenColorTokens={onOpenColorTokens}
                  onRegisterRefresh={handleRegisterRefreshTokens}
                />
              ),
              defaultFlexGrow: 1,
              defaultCollapsed: true,
              resizable: true,
              actions: globalTokensActions,
            },
          ],
        },
      ];
    }, [
      t,
      repoPath,
      regularSessions,
      privateSessions,
      activeSessionId,
      onSelectSession,
      onCloseSession,
      regularActions,
      privateActions,
      sessions,
      onOpenHistoryUrl,
      showFilterTokens,
      showFilterRegularSessions,
      showFilterPrivateSessions,
      onOpenColorTokens,
      handleRegisterRefreshTokens,
      globalTokensActions,
      sessionsOnly,
    ]);

    return (
      <PrimarySidebarLayout
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        tabIconOnly={true}
        hideTabs={sessionsOnly}
      />
    );
  }
);

BrowserPrimarySidebar.displayName = "BrowserPrimarySidebar";

export default BrowserPrimarySidebar;

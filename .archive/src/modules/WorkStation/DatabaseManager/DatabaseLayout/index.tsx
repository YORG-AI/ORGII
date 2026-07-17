/**
 * DatabaseLayout Component
 *
 * Layout orchestrator for Database Manager.
 * Coordinates the sidebar, main pane, and overlays.
 */
import { DatabasePalette } from "@/src/scaffold/GlobalSpotlight/palettes";
import { useSetAtom } from "jotai";
import React, {
  Suspense,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { DatabaseConnectionConfig } from "@src/engines/DatabaseCore";
import { useSqliteDatabase } from "@src/hooks/database";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { useMounted } from "@src/hooks/lifecycle/useMounted";
import {
  usePrimarySidebarState,
  useWorkStationTabShortcutBridge,
  useWorkStationTabs,
} from "@src/hooks/workStation";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  createBranchSpotlightRequest,
  createWorkspaceSpotlightRequest,
} from "@src/scaffold/GlobalSpotlight/openSpotlight";
import AddConnectionWizard from "@src/scaffold/WizardSystem/variants/Database/AddConnectionWizard";
import {
  spotlightInitialQueryAtom,
  spotlightOpenAtom,
} from "@src/store/ui/uiAtom";
import {
  dataStatusBarCallbacksAtom,
  dataStatusBarStateAtom,
} from "@src/store/ui/workStationAtom";
import { addConnectionConfig } from "@src/store/workstation/database";
import { tabToHost } from "@src/store/workstation/tabHost";
import {
  createAddConnectionTab,
  createTableTab,
} from "@src/store/workstation/tabs";

import {
  NoTabsPlaceholder,
  WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS,
  WorkStationShell,
  buildPrimarySidebarConfig,
} from "../../shared";
import DatabasePrimarySidebar from "../Panels/DatabasePrimarySidebar";
import { createDatabaseQuickActions } from "./config";

// Lazy-load DatabaseMainPane — it pulls in CodeMirror (SQL editor) and DataGrid,
// which are only needed when a table tab is actually opened.
const DatabaseMainPane = React.lazy(() => import("../Panels/DatabaseMainPane"));

// ============================================
// Types
// ============================================

export interface DatabaseLayoutProps {
  /** Repository path (for context, e.g., finding .sqlite files) */
  repoPath: string;
  /** Repository name for display */
  repoName: string;
}

// ============================================
// Component
// ============================================

export const DatabaseLayout: React.FC<DatabaseLayoutProps> = memo(
  ({ repoPath, repoName }) => {
    const { t } = useTranslation();
    // Get branch info for status bar
    const { currentBranch } = useRepoSelection({ autoLoad: false });

    // Shared panel state
    const {
      layoutMode,
      primarySidebarCollapsed,
      primarySidebarWidth,
      setPrimarySidebarWidth,
      setLayoutMode,
      togglePrimarySidebar,
      closePrimarySidebar,
    } = usePrimarySidebarState();

    // Database connections
    const { connections } = useSqliteDatabase();

    // Unified tab system — backed by the single mainPane pool that is
    // shared across every Workstation host (Code / Browser / Database /
    // Project). Filter down to data-host tabs so the Database surface
    // only reacts to its own tabs; otherwise opening Database from a
    // route where another host's tab is globally active (e.g. the Code
    // Editor's pinned Explorer tab on first paint) would render
    // `DatabaseMainPane` with no connection/table and surface a ghost
    // "no data" grid even though the user has not opened a single
    // database tab.
    const { tabs, activeTab, openTab, closeTab } = useWorkStationTabs();

    const dataTabs = useMemo(
      () => tabs.filter((tab) => tabToHost(tab) === "data"),
      [tabs]
    );
    const dataActiveTab = useMemo(() => {
      if (!activeTab) return null;
      return tabToHost(activeTab) === "data" ? activeTab : null;
    }, [activeTab]);

    // Derive selected connection/table from the data-host active tab.
    const selectedConnectionId =
      (dataActiveTab?.data.connectionId as string) || null;
    const selectedTable = (dataActiveTab?.data.tableName as string) || null;

    // Get tables for the active connection (for SQL autocomplete)
    const activeConnectionTables = useMemo(() => {
      if (!selectedConnectionId) return [];
      const connection = connections.find(
        (conn) => conn.id === selectedConnectionId
      );
      return connection?.tables || [];
    }, [selectedConnectionId, connections]);

    // Overlay states
    const [showDbSelector, setShowDbSelector] = useState(false);

    // Ref to the active pane's executeQuery function (registered by DatabaseMainPane)
    const executeQueryRef = useRef<((sql: string) => Promise<void>) | null>(
      null
    );
    const handleRegisterExecuteQuery = useCallback(
      (fn: (sql: string) => Promise<void>) => {
        executeQueryRef.current = fn;
      },
      []
    );
    const handleRunQuery = useCallback((sql: string) => {
      executeQueryRef.current?.(sql);
    }, []);

    // Handle selecting a connection (from left panel)
    const handleSelectConnection = useCallback(
      (_connectionId: string | null) => {
        // Just select - don't open tab until a table is selected
      },
      []
    );

    // Handle selecting table with connection ID (for direct opening)
    const handleSelectTableWithConnection = useCallback(
      (connectionId: string, tableName: string) => {
        const connection = connections.find((conn) => conn.id === connectionId);
        if (connection) {
          const tab = createTableTab(connectionId, tableName, connection.name);
          openTab(tab);
        }
      },
      [connections, openTab]
    );

    // Handle closing all tabs for a connection (when connection is closed)
    const handleCloseConnectionTabs = useCallback(
      (connectionId: string) => {
        dataTabs.forEach((tab) => {
          if (tab.data.connectionId === connectionId) {
            closeTab(tab.id);
          }
        });
      },
      [dataTabs, closeTab]
    );

    const setSpotlightInitialQuery = useSetAtom(spotlightInitialQueryAtom);
    const setSpotlightOpen = useSetAtom(spotlightOpenAtom);

    const handleRepoClick = useCallback(() => {
      setSpotlightInitialQuery(createWorkspaceSpotlightRequest("switch"));
      setSpotlightOpen(true);
    }, [setSpotlightInitialQuery, setSpotlightOpen]);

    const handleBranchClick = useCallback(() => {
      setSpotlightInitialQuery(createBranchSpotlightRequest());
      setSpotlightOpen(true);
    }, [setSpotlightInitialQuery, setSpotlightOpen]);

    // === Global StatusBar state (unified) ===
    const setGlobalStatusBarState = useSetAtom(dataStatusBarStateAtom);
    const setStatusBarCallbacks = useSetAtom(dataStatusBarCallbacksAtom);

    const isMountedRef = useMounted();

    // Sync database state to global StatusBar atom
    useEffect(() => {
      setGlobalStatusBarState((prev) => ({
        ...prev,
        appType: "data" as const,
        cursor: null,
        filePath: null,
        totalLines: undefined,
        repoName,
        branchName: currentBranch || undefined,
        commitInfo: null,
        lspStatus: undefined,
      }));
    }, [repoName, currentBranch, setGlobalStatusBarState]);

    // Register click handlers for global StatusBar
    useEffect(() => {
      setStatusBarCallbacks((prev) => ({
        ...prev,
        onRepoClick: handleRepoClick,
        onBranchClick: handleBranchClick,
      }));
      const ref = isMountedRef;
      return () => {
        if (ref.current) return;
        setStatusBarCallbacks({});
      };
    }, [
      handleRepoClick,
      handleBranchClick,
      setStatusBarCallbacks,
      isMountedRef,
    ]);

    const handleOpenAddConnection = useCallback(() => {
      openTab(createAddConnectionTab());
    }, [openTab]);

    const handleWorkStationCloseActiveDbTab = useCallback(() => {
      if (dataActiveTab) closeTab(dataActiveTab.id);
    }, [dataActiveTab, closeTab]);

    // ⌘T is owned exclusively by the unified `+` menu (TabBarPlusMenu),
    // which Database mode does not surface. Only the close shortcut is
    // bridged here.
    useWorkStationTabShortcutBridge({
      enabled: true,
      onCloseActiveTab: handleWorkStationCloseActiveDbTab,
    });
    const handleOpenDbSelector = useCallback(() => setShowDbSelector(true), []);
    const handleCloseDbSelector = useCallback(
      () => setShowDbSelector(false),
      []
    );

    // Treat "no data tabs" *or* "no data-host active tab" as empty.
    // Foreign-host tabs in the shared mainPane (e.g. the pinned
    // Explorer tab) must not suppress the Database empty state, and
    // neither should a globally-active foreign tab that happens to
    // coexist with a stashed data tab — in both cases the user has
    // nothing meaningful selected on the Database surface.
    const hasNoTabs = !dataActiveTab;

    // Primary sidebar config
    const primarySidebarConfig = useMemo(
      () =>
        buildPrimarySidebarConfig({
          content: (
            <DatabasePrimarySidebar
              repoPath={repoPath}
              selectedConnectionId={selectedConnectionId}
              selectedTable={selectedTable}
              onSelectConnection={handleSelectConnection}
              onSelectTable={handleSelectTableWithConnection}
              onConnectionClose={handleCloseConnectionTabs}
              onOpenAddModal={handleOpenAddConnection}
              onOpenDbSelector={handleOpenDbSelector}
              onRunQuery={handleRunQuery}
            />
          ),
          collapsed: primarySidebarCollapsed,
          size: primarySidebarWidth,
          onSizeChange: setPrimarySidebarWidth,
          onClose: closePrimarySidebar,
          onPositionChange: setLayoutMode,
          minSize: 200,
          maxSize: 500,
        }),
      [
        repoPath,
        selectedConnectionId,
        selectedTable,
        handleSelectConnection,
        handleSelectTableWithConnection,
        handleCloseConnectionTabs,
        handleOpenAddConnection,
        handleOpenDbSelector,
        handleRunQuery,
        primarySidebarCollapsed,
        primarySidebarWidth,
        setPrimarySidebarWidth,
        setLayoutMode,
        closePrimarySidebar,
      ]
    );

    // Quick actions from config
    const databaseQuickActions = useMemo(
      () =>
        createDatabaseQuickActions({
          t,
          onOpenSpotlight: () => setSpotlightOpen(true),
          sidebarCollapsed: primarySidebarCollapsed,
          onToggleSidebar: togglePrimarySidebar,
        }),
      [t, setSpotlightOpen, primarySidebarCollapsed, togglePrimarySidebar]
    );

    const handleWizardSave = useCallback(
      (config: DatabaseConnectionConfig) => {
        addConnectionConfig(config);
        if (dataActiveTab) closeTab(dataActiveTab.id);
      },
      [dataActiveTab, closeTab]
    );

    const handleWizardCancel = useCallback(() => {
      if (dataActiveTab) closeTab(dataActiveTab.id);
    }, [dataActiveTab, closeTab]);

    const isAddConnectionTab = dataActiveTab?.type === "add-connection";

    const mainContent = (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {hasNoTabs ? (
          <NoTabsPlaceholder icon="database" actions={databaseQuickActions} />
        ) : isAddConnectionTab ? (
          <AddConnectionWizard
            onSave={handleWizardSave}
            onCancel={handleWizardCancel}
          />
        ) : (
          <Suspense
            fallback={
              <Placeholder
                variant="loading"
                placement="detail-panel"
                fillParentHeight
                className={WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS}
              />
            }
          >
            <DatabaseMainPane
              connectionId={selectedConnectionId}
              tableName={selectedTable}
              repoPath={repoPath}
              tables={activeConnectionTables}
              onRegisterExecuteQuery={handleRegisterExecuteQuery}
            />
          </Suspense>
        )}
      </div>
    );

    // Status bar is rendered by StatusBarRenderer (via AppShell for inset, AppLayout for full)
    // No local status bar needed here.

    return (
      <>
        <WorkStationShell
          primarySidebarConfig={primarySidebarConfig}
          content={mainContent}
          statusBar={null}
          layoutMode={layoutMode}
        />

        {/* Overlays */}
        <DatabasePalette
          isOpen={showDbSelector}
          onClose={handleCloseDbSelector}
          onScanPath={async (_path: string) => {
            // This will be handled by the sidebar
            handleCloseDbSelector();
          }}
        />
      </>
    );
  }
);

DatabaseLayout.displayName = "DatabaseLayout";

export default DatabaseLayout;

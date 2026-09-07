/**
 * Kanban pane
 *
 * Reuses the existing `TaskKanban` feature to give a single board view of
 * agent status inside Workstation.
 *
 * Two host contexts:
 *   - Chat pane (default): renders beneath the Chat Panel tab bar.
 *   - WorkStation tab (`embedded`): renders beneath the WorkStation tab bar.
 * Surface controls always stay inside the page, including while lazy content
 * loads or the host folds its single tab into a compact heading.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React from "react";

import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import { Placeholder } from "@src/components/Placeholder";
import { usePublishChatPanelHeader } from "@src/engines/ChatPanel/header";
import FactoryViewPill from "@src/features/TaskKanban/components/FactoryViewPill";
import KanbanOrgScopeSelect from "@src/features/TaskKanban/components/KanbanOrgScopeSelect";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import SplitListHeader from "@src/modules/shared/layouts/SplitListHeader";
import {
  activeWorkManagementSectionAtom,
  setActiveWorkManagementSectionAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  WORK_MANAGEMENT_PROJECTS_VIEW,
  WORK_MANAGEMENT_SECTION,
  workManagementProjectsViewAtom,
  workstationTabHeaderAtomByHost,
} from "@src/store/workstation";

import { WorkManagementDatasetSwitch } from "./WorkManagementDatasetSwitch";
import "./index.scss";
import {
  WORK_MANAGEMENT_DATASET,
  type WorkManagementDataset,
  resolveWorkManagementDataset,
} from "./workManagementDataset";
import { WorkManagementSplitHeaderContext } from "./workManagementSplitHeaderContext";

const TaskKanban = React.lazy(() => import("@src/features/TaskKanban"));
const GitHubWorkItemsSurface = React.lazy(
  () => import("./GitHubWorkItemsSurface")
);
const WorkManagementProjectsSurface = React.lazy(
  () => import("./WorkManagementProjectsSurface")
);
const WorkManagementTaskCreator = React.lazy(
  () => import("./WorkManagementTaskCreator")
);
const ConnectedTeamInboxView = React.lazy(
  () => import("@src/modules/MainApp/TeamInbox/ConnectedTeamInboxView")
);
const RoutineRunsSurface = React.lazy(() => import("./RoutineRunsSurface"));

interface WorkManagementPageProps {
  /**
   * When true, the pane is hosted inside a WorkStation tab. Surface controls
   * remain below the host chrome in either placement.
   */
  embedded?: boolean;
  /** Whether the host currently renders a tab row above this surface. */
  hasTabBar?: boolean;
}

const WorkManagementPage: React.FC<WorkManagementPageProps> = ({
  embedded = false,
  hasTabBar = true,
}) => {
  const activeHomeTab = useAtomValue(activeWorkManagementSectionAtom);
  const projectsView = useAtomValue(workManagementProjectsViewAtom);
  const setProjectsView = useSetAtom(workManagementProjectsViewAtom);
  const setActiveWorkManagementSection = useSetAtom(
    setActiveWorkManagementSectionAtom
  );
  const headerSlots = useAtomValue(
    workstationTabHeaderAtomByHost.workManagement
  );
  const showViewSwitch = activeHomeTab === WORK_MANAGEMENT_SECTION.KANBAN;
  const activeDataset = resolveWorkManagementDataset({
    section: activeHomeTab,
    projectsView,
  });
  const detailHost = embedded ? "workstation" : "chat";
  const handleDatasetChange = React.useCallback(
    (dataset: WorkManagementDataset) => {
      if (dataset === WORK_MANAGEMENT_DATASET.PROJECTS) {
        setProjectsView(WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS);
        setActiveWorkManagementSection({
          section: WORK_MANAGEMENT_SECTION.PROJECTS,
        });
        return;
      }
      if (dataset === WORK_MANAGEMENT_DATASET.WORK_ITEMS) {
        setProjectsView(WORK_MANAGEMENT_PROJECTS_VIEW.WORK_ITEMS);
        setActiveWorkManagementSection({
          section: WORK_MANAGEMENT_SECTION.PROJECTS,
        });
        return;
      }
      if (dataset === WORK_MANAGEMENT_DATASET.INBOX) {
        setActiveWorkManagementSection({
          section: WORK_MANAGEMENT_SECTION.INBOX,
        });
        return;
      }
      if (dataset === WORK_MANAGEMENT_DATASET.RUNS) {
        setActiveWorkManagementSection({
          section: WORK_MANAGEMENT_SECTION.RUNS,
        });
        return;
      }
      setActiveWorkManagementSection({
        section:
          dataset === WORK_MANAGEMENT_DATASET.GITHUB_ISSUES
            ? WORK_MANAGEMENT_SECTION.GITHUB_ISSUES
            : WORK_MANAGEMENT_SECTION.GITHUB_PRS,
      });
    },
    [setActiveWorkManagementSection, setProjectsView]
  );

  // Leading controls for the page-owned row below the host tab bar.
  const headerLeadingControl = React.useMemo(() => {
    if (showViewSwitch) {
      return <FactoryViewPill />;
    }
    if (activeDataset) {
      return (
        <WorkManagementDatasetSwitch
          activeDataset={activeDataset}
          onChange={handleDatasetChange}
        />
      );
    }
    return null;
  }, [activeDataset, handleDatasetChange, showViewSwitch]);

  // A split list uses an icon-only dataset switch; a full-width surface keeps
  // the readable dataset title in its own row beneath the host tab bar.
  const splitDatasetControl = React.useMemo(() => {
    if (!activeDataset || showViewSwitch) return null;
    return (
      <WorkManagementDatasetSwitch
        activeDataset={activeDataset}
        onChange={handleDatasetChange}
        compact
      />
    );
  }, [activeDataset, handleDatasetChange, showViewSwitch]);

  const headerLeading = React.useMemo(() => {
    if (!headerLeadingControl) return null;
    return showViewSwitch ? (
      <>
        <KanbanOrgScopeSelect />
        <HeaderSectionSeparator />
        {headerLeadingControl}
      </>
    ) : (
      <>
        {headerLeadingControl}
        <HeaderSectionSeparator />
      </>
    );
  }, [headerLeadingControl, showViewSwitch]);

  const headerPrimaryContent = React.useMemo(() => {
    if (headerSlots?.hidden) return null;
    if (!headerLeading && !headerSlots?.content) return null;
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {headerLeading}
        {headerSlots?.content}
      </div>
    );
  }, [headerLeading, headerSlots?.content, headerSlots?.hidden]);

  // Header placement must not depend on a lazy child's publication. Otherwise
  // a null/stale slot briefly forwards controls into the folded chat tab row
  // before the child mounts and declares its local header with `hidden: true`.
  // The shell only owns tab chrome; it never receives surface controls.
  const embeddedHeaderContent = React.useMemo(
    () => ({
      shellLeadingChromeHidden: true,
      hidden: true,
    }),
    []
  );
  usePublishWorkstationTabHeader({
    host: "code",
    content: embeddedHeaderContent,
    enabled: embedded,
  });

  const chatHeaderContent = React.useMemo(
    () => ({
      // When folded, leave the host's heading and new-tab/restore controls.
      hidden: hasTabBar,
    }),
    [hasTabBar]
  );
  usePublishChatPanelHeader({
    content: chatHeaderContent,
    enabled: !embedded,
  });

  // Inbox, PRs, issues, and routines own their split/full-width headers.
  // Kanban and project subpages that still contribute slots use that same
  // local 36px row primitive here. Ignore an outgoing publisher in other tabs.
  const showSurfaceHeader =
    (showViewSwitch ||
      (activeHomeTab === WORK_MANAGEMENT_SECTION.PROJECTS && headerSlots)) &&
    !headerSlots?.hidden;

  const mainContent = (
    <div className="work-management-page flex h-full min-h-0 w-full flex-col overflow-hidden">
      {showSurfaceHeader ? (
        <SplitListHeader
          fullWidth
          primary={
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {headerPrimaryContent}
              <div className="ml-auto flex min-w-0 shrink-0 items-center gap-px">
                {headerSlots?.trailing}
              </div>
            </div>
          }
        />
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <React.Suspense
          fallback={
            <Placeholder
              variant="loading"
              placement="detail-panel"
              fillParentHeight
            />
          }
        >
          {activeHomeTab === WORK_MANAGEMENT_SECTION.PROJECTS ? (
            <WorkManagementProjectsSurface detailHost={detailHost} />
          ) : activeHomeTab === WORK_MANAGEMENT_SECTION.INBOX ? (
            <ConnectedTeamInboxView />
          ) : activeHomeTab === WORK_MANAGEMENT_SECTION.GITHUB_ISSUES ? (
            <GitHubWorkItemsSurface scope="issue" detailHost={detailHost} />
          ) : activeHomeTab === WORK_MANAGEMENT_SECTION.GITHUB_PRS ? (
            <GitHubWorkItemsSurface scope="pr" detailHost={detailHost} />
          ) : activeHomeTab === WORK_MANAGEMENT_SECTION.RUNS ? (
            <RoutineRunsSurface />
          ) : (
            <>
              <TaskKanban />
              <WorkManagementTaskCreator />
            </>
          )}
        </React.Suspense>
      </div>
    </div>
  );

  const splitHeaderContextValue = React.useMemo(
    () => ({
      splitDatasetControl,
      surfaceDatasetControl: headerLeadingControl,
    }),
    [headerLeadingControl, splitDatasetControl]
  );

  return (
    <WorkManagementSplitHeaderContext.Provider value={splitHeaderContextValue}>
      <div className="h-full min-h-0 w-full">{mainContent}</div>
    </WorkManagementSplitHeaderContext.Provider>
  );
};

export default WorkManagementPage;

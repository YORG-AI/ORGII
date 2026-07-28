/**
 * Kanban pane
 *
 * Reuses the existing `TaskKanban` feature to give a single board view of
 * agent status inside Workstation.
 *
 * Two host contexts:
 *   - Chat pane (default): republishes its controls into the chat shell's
 *     shared 40px published-header row.
 *   - WorkStation tab (`embedded`): the WorkStation already renders the shared
 *     40px `WorkstationTabHeader`, so we suppress our own header row and instead
 *     republish the same controls into the `code` host slot — avoiding a
 *     duplicate header bar.
 */
import { useAtomValue } from "jotai";
import { ArrowLeft } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { usePublishChatPanelHeader } from "@src/engines/ChatPanel/header";
import TaskKanban from "@src/features/TaskKanban";
import FactoryViewPill from "@src/features/TaskKanban/components/FactoryViewPill";
import KanbanOrgScopeSelect from "@src/features/TaskKanban/components/KanbanOrgScopeSelect";
import { useElementDimensions } from "@src/hooks/ui/layout";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import {
  WorkstationHeaderSectionSeparator,
  WorkstationToolbarTooltip,
} from "@src/modules/WorkStation/shared";
import { activeWorkManagementSectionAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  WORK_MANAGEMENT_SECTION,
  workstationTabHeaderAtomByHost,
} from "@src/store/workstation";

import { shouldUseSingleRowGitHubWorkItemsHeader } from "./GitHubWorkItemList";
import GitHubWorkItemsSurface from "./GitHubWorkItemsSurface";
import WorkManagementProjectsSurface from "./WorkManagementProjectsSurface";
import WorkManagementTaskCreator from "./WorkManagementTaskCreator";
import "./index.scss";

export interface WorkManagementPageProps {
  /**
   * When true, the pane is hosted inside a WorkStation tab that already renders
   * the shared 40px header. The pane hides its own header row and republishes
   * its controls into the `code` host slot instead.
   */
  embedded?: boolean;
}

const WorkManagementPage: React.FC<WorkManagementPageProps> = ({
  embedded = false,
}) => {
  const { t } = useTranslation("common");
  const containerRef = React.useRef<HTMLDivElement>(null);
  const containerWidth = useElementDimensions(containerRef, {
    dimension: "width",
  });
  const singleRowGitHubHeader =
    shouldUseSingleRowGitHubWorkItemsHeader(containerWidth);
  const activeHomeTab = useAtomValue(activeWorkManagementSectionAtom);
  const headerSlots = useAtomValue(
    workstationTabHeaderAtomByHost.workManagement
  );
  const [githubDetailOpen, setGitHubDetailOpen] = React.useState(false);
  const githubDetailBackRef = React.useRef<(() => void) | null>(null);
  const handleGitHubDetailViewChange = React.useCallback(
    (open: boolean, onBack: (() => void) | null) => {
      githubDetailBackRef.current = open ? onBack : null;
      setGitHubDetailOpen(open);
    },
    []
  );
  const githubDetailActive =
    githubDetailOpen &&
    (activeHomeTab === WORK_MANAGEMENT_SECTION.GITHUB_ISSUES ||
      activeHomeTab === WORK_MANAGEMENT_SECTION.GITHUB_PRS);

  const showViewSwitch =
    activeHomeTab === WORK_MANAGEMENT_SECTION.KANBAN && !githubDetailActive;

  // Leading header control: GitHub detail "back" button, else the view-switch
  // pill. Shared by the chat-pane and WorkStation published-header slots.
  const headerLeadingControl = React.useMemo(() => {
    if (githubDetailActive) {
      return (
        <WorkstationToolbarTooltip label={t("actions.back")}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            icon={<ArrowLeft size={14} strokeWidth={2.25} />}
            aria-label={t("actions.back")}
            onClick={() => githubDetailBackRef.current?.()}
          />
        </WorkstationToolbarTooltip>
      );
    }
    if (showViewSwitch) {
      return <FactoryViewPill />;
    }
    return null;
  }, [githubDetailActive, showViewSwitch, t]);

  const headerLeading = React.useMemo(() => {
    if (!headerLeadingControl) return null;
    return (
      <div className="flex shrink-0 items-center gap-2">
        {showViewSwitch ? (
          <>
            <KanbanOrgScopeSelect />
            <WorkstationHeaderSectionSeparator />
            {headerLeadingControl}
          </>
        ) : (
          <>
            {headerLeadingControl}
            <WorkstationHeaderSectionSeparator />
          </>
        )}
      </div>
    );
  }, [headerLeadingControl, showViewSwitch]);

  // WorkStation embed: publish the pane's controls into the shared 40px bar
  // (and disable the sidebar toggle) instead of rendering our own header row.
  const embeddedHeaderContent = React.useMemo(
    () => ({
      leading: headerLeading,
      content: headerSlots?.content ?? null,
      trailing: headerSlots?.trailing ?? null,
      sidebarToggleDisabled: true,
      joinWithFollowingRow: headerSlots?.joinWithFollowingRow ?? false,
    }),
    [headerLeading, headerSlots]
  );
  usePublishWorkstationTabHeader({
    host: "code",
    content: embeddedHeaderContent,
    enabled: embedded,
  });

  const chatHeaderContent = React.useMemo(
    () => ({
      leading: headerLeading,
      content: headerSlots?.content ?? null,
      trailing: headerSlots?.trailing ?? null,
      joinWithFollowingRow: headerSlots?.joinWithFollowingRow ?? false,
    }),
    [headerLeading, headerSlots]
  );
  usePublishChatPanelHeader({
    content: chatHeaderContent,
    enabled: !embedded,
  });

  const mainContent = (
    <div className="work-management-page flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {activeHomeTab === WORK_MANAGEMENT_SECTION.PROJECTS ? (
          <WorkManagementProjectsSurface />
        ) : activeHomeTab === WORK_MANAGEMENT_SECTION.GITHUB_ISSUES ? (
          <GitHubWorkItemsSurface
            scope="issue"
            singleRowHeader={singleRowGitHubHeader}
            onDetailViewChange={handleGitHubDetailViewChange}
          />
        ) : activeHomeTab === WORK_MANAGEMENT_SECTION.GITHUB_PRS ? (
          <GitHubWorkItemsSurface
            scope="pr"
            singleRowHeader={singleRowGitHubHeader}
            onDetailViewChange={handleGitHubDetailViewChange}
          />
        ) : (
          <>
            <TaskKanban />
            <WorkManagementTaskCreator />
          </>
        )}
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className="h-full min-h-0 w-full">
      {mainContent}
    </div>
  );
};

export default WorkManagementPage;

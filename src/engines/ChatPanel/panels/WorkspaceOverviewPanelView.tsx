import { useAtom, useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import WorkItemContentStack from "@src/modules/ProjectManager/WorkItems/components/WorkItemContentStack";
import { RepoDetailPage } from "@src/modules/shared/launchpad/components";
import { CodeMapWorkspaceStatusPanel } from "@src/modules/shared/launchpad/components/CodeMapWorkspaceStatus";
import RepoActionButtons from "@src/modules/shared/launchpad/components/RepoActionButtons";
import { WorkspaceToolsReadiness } from "@src/modules/shared/launchpad/components/WorkspaceToolsReadiness";
import { useRepoDetection } from "@src/modules/shared/launchpad/hooks";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  PanelFooter,
} from "@src/modules/shared/layouts/blocks";
import { reposAtom } from "@src/store/repo";
import type { Repo } from "@src/store/repo/types";
import {
  type ChatPanelSelectedWorkspace,
  WORKSPACE_OVERVIEW_TAB,
  type WorkspaceOverviewTab,
  chatPanelWorkspaceOverviewTabAtom,
} from "@src/store/ui/chatPanelAtom";

import AgentBlamePanelView from "./AgentBlamePanelView";
import RecentSessionsPanelView from "./RecentSessionsPanelView";

interface WorkspaceOverviewPanelViewProps {
  selectedWorkspace: ChatPanelSelectedWorkspace;
}

interface WorkspaceOverviewBodyProps {
  repoPath: string;
}

const WorkspaceOverviewBody = memo(
  ({ repoPath }: WorkspaceOverviewBodyProps) => {
    const { repoType, configFiles, hasDocker, hasMakefile } =
      useRepoDetection(repoPath);

    return (
      <>
        <CodeMapWorkspaceStatusPanel workspacePath={repoPath} />
        <WorkspaceToolsReadiness
          workspacePath={repoPath}
          repoType={repoType}
          configFiles={configFiles}
          hasDocker={hasDocker}
          hasMakefile={hasMakefile}
        />
      </>
    );
  }
);
WorkspaceOverviewBody.displayName = "WorkspaceOverviewBody";

interface WorkspaceOverviewFooterProps {
  repo: Repo;
  onOpenDetails: () => void;
}

const WorkspaceOverviewFooter = memo(
  ({ repo, onOpenDetails }: WorkspaceOverviewFooterProps) => (
    <PanelFooter
      left={
        <RepoActionButtons
          repo={repo}
          onOpenDetails={onOpenDetails}
          shape="square"
          showDetails={false}
          showClose={false}
          className="overflow-x-auto scrollbar-hide"
        />
      }
    />
  )
);
WorkspaceOverviewFooter.displayName = "WorkspaceOverviewFooter";

const WorkspaceOverviewPanelView: React.FC<WorkspaceOverviewPanelViewProps> =
  memo(({ selectedWorkspace }) => {
    const { t } = useTranslation(["navigation", "common"]);
    const [activeTab, setActiveTab] = useAtom(
      chatPanelWorkspaceOverviewTabAtom
    );
    const repos = useAtomValue(reposAtom);

    const selectedRepo = useMemo(
      () =>
        selectedWorkspace.kind === "repo"
          ? (repos.find((repo) => repo.id === selectedWorkspace.id) ?? null)
          : null,
      [repos, selectedWorkspace.id, selectedWorkspace.kind]
    );

    const isRepo = selectedWorkspace.kind === "repo";
    const detailsTabAvailable = isRepo && Boolean(selectedRepo);

    // The Overview body (code map + tools readiness) works on any workspace
    // path — the Rust code-map engine indexes plain folders, not just git
    // repos. Resolve the path from the selected repo when present, otherwise
    // fall back to the folder workspace's own path so non-git folders also get
    // the code map panel instead of an empty Overview.
    const overviewPath = selectedRepo?.path ?? selectedWorkspace.path ?? null;

    // Force back to Overview when the selected workspace cannot show details
    // (workspace-kind, or repo not yet hydrated). Prevents a stale "details"
    // selection from showing a blank panel after switching workspaces.
    useEffect(() => {
      if (
        !detailsTabAvailable &&
        (activeTab === WORKSPACE_OVERVIEW_TAB.DETAILS ||
          activeTab === WORKSPACE_OVERVIEW_TAB.RECENT_SESSION ||
          activeTab === WORKSPACE_OVERVIEW_TAB.AGENT_BLAME)
      ) {
        setActiveTab(WORKSPACE_OVERVIEW_TAB.OVERVIEW);
      }
    }, [activeTab, detailsTabAvailable, setActiveTab]);

    const tabs = useMemo<TabPillItem[]>(() => {
      const items: TabPillItem[] = [
        {
          key: WORKSPACE_OVERVIEW_TAB.OVERVIEW,
          label: t("common:labels.overview"),
        },
      ];
      if (detailsTabAvailable) {
        items.push(
          {
            key: WORKSPACE_OVERVIEW_TAB.DETAILS,
            label: t("common:labels.details"),
          },
          {
            key: WORKSPACE_OVERVIEW_TAB.RECENT_SESSION,
            label: t("navigation:routes.sessions"),
          },
          {
            key: WORKSPACE_OVERVIEW_TAB.AGENT_BLAME,
            label: t("common:labels.agentBlame"),
          }
        );
      }
      return items;
    }, [detailsTabAvailable, t]);

    const handleTabChange = useCallback(
      (key: string) => {
        setActiveTab(key as WorkspaceOverviewTab);
      },
      [setActiveTab]
    );

    const resolvedActiveTab: WorkspaceOverviewTab = detailsTabAvailable
      ? activeTab
      : WORKSPACE_OVERVIEW_TAB.OVERVIEW;

    const handleOpenDetails = useCallback(() => {
      setActiveTab(WORKSPACE_OVERVIEW_TAB.DETAILS);
    }, [setActiveTab]);

    const detailsBody =
      resolvedActiveTab === WORKSPACE_OVERVIEW_TAB.DETAILS && selectedRepo ? (
        <RepoDetailPage repo={selectedRepo} />
      ) : null;

    const recentSessionBody =
      resolvedActiveTab === WORKSPACE_OVERVIEW_TAB.RECENT_SESSION &&
      selectedRepo?.path ? (
        <RecentSessionsPanelView
          repoPath={selectedRepo.path}
          repoName={selectedRepo.name}
        />
      ) : null;

    const agentBlameBody =
      resolvedActiveTab === WORKSPACE_OVERVIEW_TAB.AGENT_BLAME &&
      selectedRepo?.path ? (
        <AgentBlamePanelView repoPath={selectedRepo.path} />
      ) : null;

    const overviewBody =
      resolvedActiveTab === WORKSPACE_OVERVIEW_TAB.OVERVIEW && overviewPath ? (
        <WorkspaceOverviewBody repoPath={overviewPath} />
      ) : null;

    const actionFooter =
      selectedRepo && resolvedActiveTab === WORKSPACE_OVERVIEW_TAB.OVERVIEW ? (
        <WorkspaceOverviewFooter
          repo={selectedRepo}
          onOpenDetails={handleOpenDetails}
        />
      ) : null;

    const descriptionContent = (
      <section
        className={`${DETAIL_PANEL_TOKENS.contentWidth} flex min-h-0 flex-1 flex-col`}
        data-testid="chat-panel-workspace-overview-section"
      >
        <div className="mb-4 flex shrink-0 items-center justify-start">
          <TabPill
            tabs={tabs}
            activeTab={resolvedActiveTab}
            onChange={handleTabChange}
            variant="simple"
            fillWidth={false}
            size="chatPanel"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          {overviewBody}
          {detailsBody}
          {recentSessionBody}
          {agentBlameBody}
        </div>
      </section>
    );

    return (
      <div
        className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
        data-testid="chat-panel-workspace-overview-detail"
      >
        <DetailPanelContainer testId="workspace-overview-panel">
          <WorkItemContentStack
            descriptionContent={descriptionContent}
            descriptionClassName="px-4 pt-2"
            descriptionFlexible
          />
          {actionFooter}
        </DetailPanelContainer>
      </div>
    );
  });

WorkspaceOverviewPanelView.displayName = "WorkspaceOverviewPanelView";

export default WorkspaceOverviewPanelView;

/**
 * Self-sufficient chat-pane surface renderers.
 *
 * Each renderer takes the active `ChatPanelTab` and reads its typed payload
 * directly, replacing the old flow where these surfaces were selected by the
 * `show*Content` boolean cascade over the global `selected*` atoms. The panels
 * themselves are unchanged — the renderer just supplies their props from the
 * tab. Panels are lazy-loaded to preserve code-splitting.
 */
import { useSetAtom } from "jotai";
import React, { Suspense, useCallback } from "react";

import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import {
  type ChatPanelTab,
  closeAndDestroyChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";

const WorkItemPanelView = React.lazy(() =>
  import("../panels/WorkItemPanelView").then((m) => ({
    default: m.WorkItemPanelView,
  }))
);
const ProjectPanelView = React.lazy(() =>
  import("../panels/ProjectPanelView").then((m) => ({
    default: m.ProjectPanelView,
  }))
);
const ProjectOrgPanelView = React.lazy(() =>
  import("../panels/ProjectOrgPanelView").then((m) => ({
    default: m.ProjectOrgPanelView,
  }))
);
const WorkspaceOverviewPanelView = React.lazy(
  () => import("../panels/WorkspaceOverviewPanelView")
);
const CloudOrgPanelView = React.lazy(
  () => import("../panels/CloudOrgPanelView")
);
const WorkspaceExplorePanelView = React.lazy(
  () => import("../panels/WorkspaceExplorePanelView")
);
const RuntimePanelView = React.lazy(() => import("../panels/RuntimePanelView"));
const DiscussionChannelPanelView = React.lazy(
  () => import("@src/features/DiscussionChannels/ChannelPanelView")
);
const GitHubIssuePanelView = React.lazy(() =>
  import("../panels/GitHubIssuePanelView").then((m) => ({
    default: m.GitHubIssuePanelView,
  }))
);
const GitHubPrPanelView = React.lazy(() =>
  import("../panels/GitHubPrPanelView").then((m) => ({
    default: m.GitHubPrPanelView,
  }))
);
const RunGroupPanelView = React.lazy(() =>
  import("../panels/RunGroupPanelView").then((m) => ({
    default: m.RunGroupPanelView,
  }))
);

export interface ChatPanelSurfaceRendererProps {
  tab: ChatPanelTab;
}

export function WorkItemSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  const closeTab = useSetAtom(closeAndDestroyChatPanelTabAtom);
  const handleClose = useCallback(() => {
    void closeTab(tab.id);
  }, [closeTab, tab.id]);

  if (!tab.workItem) return null;
  return (
    <Suspense fallback={null}>
      <WorkItemPanelView
        selectedWorkItem={tab.workItem}
        onClose={handleClose}
      />
    </Suspense>
  );
}

export function ProjectSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  if (!tab.project) return null;
  return (
    <Suspense fallback={null}>
      <ProjectPanelView selectedProject={tab.project} />
    </Suspense>
  );
}

export function GitHubIssueSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  if (!tab.githubIssue) return null;
  return (
    <Suspense fallback={<GitHubDetailSkeleton kind="issue" showHeader />}>
      <GitHubIssuePanelView detail={tab.githubIssue} />
    </Suspense>
  );
}

export function GitHubPrSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  if (!tab.githubPr) return null;
  return (
    <Suspense fallback={<GitHubDetailSkeleton kind="pr" showHeader />}>
      <GitHubPrPanelView detail={tab.githubPr} />
    </Suspense>
  );
}

export function WorkspaceSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  if (!tab.workspace) return null;
  return (
    <Suspense fallback={null}>
      <WorkspaceOverviewPanelView selectedWorkspace={tab.workspace} />
    </Suspense>
  );
}

export function OrganizationSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  if (!tab.organization) return null;

  if (tab.organization.kind === "local") {
    const { projectOrg } = tab.organization;
    return (
      <Suspense fallback={null}>
        <ProjectOrgPanelView
          key={`${projectOrg.orgId}:${projectOrg.initialViewRequestId ?? "default"}`}
          selectedProjectOrg={projectOrg}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={null}>
      <CloudOrgPanelView selectedCloudOrg={tab.organization.cloudOrg} />
    </Suspense>
  );
}

export function ExploreSurfaceRenderer(): React.ReactNode {
  return (
    <Suspense fallback={null}>
      <WorkspaceExplorePanelView />
    </Suspense>
  );
}

export function ChannelSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  if (!tab.channel) return null;
  // Keyed per channel so switching the payload in place (rename / re-open)
  // remounts the transcript instead of replaying another channel's scroll.
  // Cloud keys carry the org id, mirroring `buildChannelTabKey`.
  const surfaceKey =
    tab.channel.scope === "cloud"
      ? `cloud:${tab.channel.orgId}:${tab.channel.channelId}`
      : `local:${tab.channel.channelId}`;
  return (
    <Suspense fallback={null}>
      <DiscussionChannelPanelView key={surfaceKey} channel={tab.channel} />
    </Suspense>
  );
}

export function RunGroupSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  if (!tab.runGroupId) return null;
  return (
    <Suspense fallback={null}>
      <RunGroupPanelView key={tab.runGroupId} runGroupId={tab.runGroupId} />
    </Suspense>
  );
}

export function RuntimeSurfaceRenderer(): React.ReactNode {
  return (
    <Suspense fallback={null}>
      <RuntimePanelView />
    </Suspense>
  );
}

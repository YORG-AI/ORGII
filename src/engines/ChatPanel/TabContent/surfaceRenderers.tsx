/**
 * Self-sufficient chat-pane surface renderers.
 *
 * Each renderer takes the active `ChatPanelTab` and reads its typed payload
 * directly, replacing the old flow where these surfaces were selected by the
 * `show*Content` boolean cascade over the global `selected*` atoms. The panels
 * themselves are unchanged — the renderer just supplies their props from the
 * tab. Panels are lazy-loaded to preserve code-splitting.
 */
import React, { Suspense } from "react";

import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

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

export interface ChatPanelSurfaceRendererProps {
  tab: ChatPanelTab;
}

export function WorkItemSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  if (!tab.workItem) return null;
  return (
    <Suspense fallback={null}>
      <WorkItemPanelView selectedWorkItem={tab.workItem} />
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

export function ProjectOrgSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  if (!tab.projectOrg) return null;
  return (
    <Suspense fallback={null}>
      <ProjectOrgPanelView selectedProjectOrg={tab.projectOrg} />
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

export function CloudOrgSurfaceRenderer({
  tab,
}: ChatPanelSurfaceRendererProps): React.ReactNode {
  if (!tab.cloudOrg) return null;
  return (
    <Suspense fallback={null}>
      <CloudOrgPanelView selectedCloudOrg={tab.cloudOrg} />
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

export function RuntimeSurfaceRenderer(): React.ReactNode {
  return (
    <Suspense fallback={null}>
      <RuntimePanelView />
    </Suspense>
  );
}

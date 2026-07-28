import React, { Suspense, useMemo } from "react";

import { UnifiedTabContent } from "@src/modules/WorkStation/TabContent/UnifiedTabContent";
import { NoTabsPlaceholder } from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import type { ProjectManagerContentRouterProps } from "../types";

const GitCommitDetailContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitCommitDetailContent")
);
const SessionContentView = React.lazy(
  () => import("@src/engines/ChatPanel/SessionContentView")
);

export const STORY_MANAGER_SUSPENSE_LOADING_FALLBACK = (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

/**
 * Routes Project Manager tab content through the unified `UnifiedTabContent`
 * dispatcher (Phase 2.1). Project tab types are looked up in the tab registry
 * and mounted via the dispatcher; the action surface they need is published
 * above this component through `ProjectHostProvider` and consumed by the
 * renderers via `useProjectHostContext`.
 *
 * Two concerns stay in this host and are deliberately NOT routed through the
 * dispatcher:
 *   - The persistent "keep-alive trio" (project-workitems /
 *     project-linear-projects / project-linear-work-items) is still mounted for
 *     every open trio tab and hidden with `display:none` when inactive, so those
 *     surfaces retain their in-tab state across tab switches. Each pane still
 *     renders through `UnifiedTabContent`.
 *   - `chat-session` and `git-commit-detail` keep bespoke inline branches: the
 *     project host needs `<ChatView secondary />` (the unified chat renderer
 *     uses `readOnly`, which is wrong here), and git-commit-detail is mounted
 *     directly from tab data.
 */
export function ProjectManagerContentRouter({
  repoPath,
  tabs,
  activeTab,
  projectQuickActions,
}: ProjectManagerContentRouterProps) {
  const hasNoTabs = tabs.length === 0;
  const persistentWorkItemTabs = useMemo(
    () =>
      tabs.filter(
        (tab) =>
          tab.type === "project-workitems" ||
          tab.type === "project-linear-projects" ||
          tab.type === "project-linear-work-items"
      ),
    [tabs]
  );

  const activeContent = renderActiveContent({
    repoPath,
    activeTab,
    hasNoTabs,
    projectQuickActions,
  });

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="project-manager-content-router"
      data-active-tab-id={activeTab?.id ?? ""}
      data-active-tab-type={activeTab?.type ?? ""}
    >
      {activeContent && (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          {activeContent}
        </div>
      )}

      {persistentWorkItemTabs.map((tab) => {
        const isActiveTab = activeTab?.id === tab.id;
        return (
          <div
            key={tab.id}
            className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
            style={{ display: isActiveTab ? undefined : "none" }}
          >
            <UnifiedTabContent tab={tab} paneId="main" isActive={isActiveTab} />
          </div>
        );
      })}
    </div>
  );
}

interface RenderActiveContentOptions {
  repoPath: string;
  activeTab: ProjectManagerContentRouterProps["activeTab"];
  hasNoTabs: boolean;
  projectQuickActions: ProjectManagerContentRouterProps["projectQuickActions"];
}

function renderActiveContent({
  repoPath,
  activeTab,
  hasNoTabs,
  projectQuickActions,
}: RenderActiveContentOptions): React.ReactNode {
  if (hasNoTabs || !activeTab) {
    return <NoTabsPlaceholder icon="project" actions={projectQuickActions} />;
  }

  // The keep-alive trio is rendered by the persistent multiplexer below, so the
  // active-content slot renders nothing for it.
  if (
    activeTab.type === "project-workitems" ||
    activeTab.type === "project-linear-projects" ||
    activeTab.type === "project-linear-work-items"
  ) {
    return null;
  }

  // Edge case: the project host needs `<ChatView secondary />`. The unified
  // chat-session renderer mounts it `readOnly`, which is wrong here — keep the
  // bespoke inline branch.
  if (activeTab.type === "chat-session") {
    const chatSessionId = String(activeTab.data.sessionId || "");
    if (!chatSessionId) return null;
    return (
      <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
        <div
          data-chat-panel
          className="flex h-full min-w-0 flex-1 flex-col overflow-hidden text-sm"
          style={{
            background:
              "linear-gradient(180deg, var(--color-bg-1) 0%, var(--color-fill-1) 100%)",
          }}
        >
          <SessionContentView sessionId={chatSessionId} secondary />
        </div>
      </Suspense>
    );
  }

  // Edge case: git-commit-detail is mounted directly from tab data with the
  // host's repo path; keep the bespoke inline branch.
  if (activeTab.type === "git-commit-detail") {
    const commitSha = String(activeTab.data.commitSha || "");
    const commitShortSha = String(activeTab.data.shortSha || "");
    const commitMessage = String(activeTab.data.commitMessage || "");

    return (
      <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
        <GitCommitDetailContent
          commitSha={commitSha}
          shortSha={commitShortSha}
          commitMessage={commitMessage}
          repoPath={repoPath}
          repoId={repoPath}
        />
      </Suspense>
    );
  }

  // All remaining project tab types route through the unified dispatcher.
  switch (activeTab.type) {
    case "project-dashboard":
    case "project-work-items":
    case "project-git-sync-review":
    case "project-org":
    case "project-org-settings":
    case "project-settings":
    case "workItem-detail":
      return <UnifiedTabContent tab={activeTab} paneId="main" isActive />;

    default:
      return <NoTabsPlaceholder icon="project" actions={projectQuickActions} />;
  }
}

import React, { Suspense, useMemo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { useRetainedTabPool } from "@src/hooks/tabHost/useRetainedTabPool";
import { UnifiedTabContent } from "@src/modules/WorkStation/TabContent/UnifiedTabContent";
import { NoTabsPlaceholder } from "@src/modules/WorkStation/shared";
import {
  RETENTION_POOLS,
  isTabInRetentionPool,
} from "@src/store/workstation/tabs/tabRetention";

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
 *   - The "keep-alive trio" (project-workitems / project-linear-projects /
 *     project-linear-work-items) is mounted for the active trio tab plus a
 *     bounded window of recently active ones — the `project-trio` pool in
 *     `tabRetention.ts` — hidden with `display:none` when inactive, so
 *     flipping between two lists keeps their in-tab state and scroll
 *     position. Older trio tabs unmount: each one is a full non-virtualized
 *     table, and every open one used to stay resident for the life of the
 *     host. Each pane still renders through `UnifiedTabContent`; the list
 *     data itself lives in atoms and survives.
 *   - `chat-session` and `git-commit-detail` keep bespoke inline branches: the
 *     project host needs `<ChatView secondary />` (the unified chat renderer
 *     uses `readOnly`, which is wrong here), and git-commit-detail is mounted
 *     directly from tab data.
 */
/** The trio's window lives in the shared retention policy. */
export const PROJECT_TRIO_KEEP_ALIVE = RETENTION_POOLS["project-trio"];

export function ProjectManagerContentRouter({
  repoPath,
  tabs,
  activeTab,
  projectQuickActions,
}: ProjectManagerContentRouterProps) {
  const hasNoTabs = tabs.length === 0;
  const persistentWorkItemTabs = useMemo(
    () => tabs.filter((tab) => isTabInRetentionPool(tab, "project-trio")),
    [tabs]
  );
  const mountedTrioTabIds = useRetainedTabPool(
    "project-trio",
    tabs,
    activeTab?.id ?? null
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
        if (!mountedTrioTabIds.has(tab.id)) return null;
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
  if (isTabInRetentionPool(activeTab, "project-trio")) {
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

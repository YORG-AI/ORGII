import { GalleryThumbnails } from "lucide-react";
import React, { Suspense } from "react";

import Button from "@src/components/Button";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import type {
  ChatHistoryDisplayMode,
  ChatPanelSelectedCollabOrg,
  ChatPanelSelectedProject,
  ChatPanelSelectedProjectOrg,
  ChatPanelSelectedWorkItem,
  ChatPanelSelectedWorkspace,
} from "@src/store/ui/chatPanelAtom";

import ChatView from "./ChatView";

const BenchmarkPanel = React.lazy(() =>
  import("@src/features/BenchmarkPanel").then((module) => ({
    default: module.BenchmarkPanel,
  }))
);
const CollabOrgPanelView = React.lazy(
  () => import("./panels/CollabOrgPanelView")
);
const ProjectOrgPanelView = React.lazy(
  () => import("./panels/ProjectOrgPanelView")
);
const ManageIssuesPanelView = React.lazy(
  () => import("./panels/ManageIssuesPanelView")
);
const ProjectPanelView = React.lazy(() => import("./panels/ProjectPanelView"));
const WorkItemPanelView = React.lazy(
  () => import("./panels/WorkItemPanelView")
);
const WorkspaceDashboardPanelView = React.lazy(
  () => import("./panels/WorkspaceDashboardPanelView")
);
const WorkspaceExplorePanelView = React.lazy(
  () => import("./panels/WorkspaceExplorePanelView")
);
const WorkspaceOverviewPanelView = React.lazy(
  () => import("./panels/WorkspaceOverviewPanelView")
);

interface ChatPanelContentProps {
  chatFocusLabel: string;
  currentSessionId: string | null;
  emptyChatContent: React.ReactNode;
  handleChatFocusToggle: () => void;
  handleRegisterSearchOpen: (handler: (() => void) | null) => void;
  displayMode: ChatHistoryDisplayMode;
  paginationEnabled: boolean;
  position: "left" | "right";
  selectedCollabOrg: ChatPanelSelectedCollabOrg | null;
  selectedProject: ChatPanelSelectedProject | null;
  selectedProjectOrg: ChatPanelSelectedProjectOrg | null;
  selectedWorkItem: ChatPanelSelectedWorkItem | null;
  selectedWorkspace: ChatPanelSelectedWorkspace | null;
  showBenchmarkSessionGroupContent: boolean;
  showCollabOrgContent: boolean;
  showEmptyChatFocusRestoreButton: boolean;
  showExploreContent: boolean;
  showManageIssuesContent: boolean;
  showPanelContent: boolean;
  showProjectContent: boolean;
  showProjectOrgContent: boolean;
  showSessionContent: boolean;
  showWorkItemContent: boolean;
  showWorkspaceDashboardContent: boolean;
  showWorkspaceOverviewContent: boolean;
}

export function ChatPanelContent({
  chatFocusLabel,
  currentSessionId,
  emptyChatContent,
  handleChatFocusToggle,
  handleRegisterSearchOpen,
  displayMode,
  paginationEnabled,
  position,
  selectedCollabOrg,
  selectedProject,
  selectedProjectOrg,
  selectedWorkItem,
  selectedWorkspace,
  showBenchmarkSessionGroupContent,
  showCollabOrgContent,
  showEmptyChatFocusRestoreButton,
  showExploreContent,
  showManageIssuesContent,
  showPanelContent,
  showProjectContent,
  showProjectOrgContent,
  showSessionContent,
  showWorkItemContent,
  showWorkspaceDashboardContent,
  showWorkspaceOverviewContent,
}: ChatPanelContentProps): React.ReactNode {
  const chatFocusTooltip = (
    <KeyboardShortcutTooltipContent
      label={chatFocusLabel}
      shortcut={getShortcutKeys("maximize_chat")}
    />
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {!showPanelContent ? null : showBenchmarkSessionGroupContent ? (
        <Suspense fallback={null}>
          <BenchmarkPanel surface="runList" />
        </Suspense>
      ) : showWorkItemContent && selectedWorkItem ? (
        <Suspense fallback={null}>
          <WorkItemPanelView selectedWorkItem={selectedWorkItem} />
        </Suspense>
      ) : showProjectContent && selectedProject ? (
        <Suspense fallback={null}>
          <ProjectPanelView selectedProject={selectedProject} />
        </Suspense>
      ) : showProjectOrgContent && selectedProjectOrg ? (
        <Suspense fallback={null}>
          <ProjectOrgPanelView selectedProjectOrg={selectedProjectOrg} />
        </Suspense>
      ) : showWorkspaceDashboardContent ? (
        <Suspense fallback={null}>
          <WorkspaceDashboardPanelView />
        </Suspense>
      ) : showExploreContent ? (
        <Suspense fallback={null}>
          <WorkspaceExplorePanelView />
        </Suspense>
      ) : showManageIssuesContent ? (
        <Suspense fallback={null}>
          <ManageIssuesPanelView />
        </Suspense>
      ) : showCollabOrgContent && selectedCollabOrg ? (
        <Suspense fallback={null}>
          <CollabOrgPanelView selectedCollabOrg={selectedCollabOrg} />
        </Suspense>
      ) : showWorkspaceOverviewContent && selectedWorkspace ? (
        <Suspense fallback={null}>
          <WorkspaceOverviewPanelView selectedWorkspace={selectedWorkspace} />
        </Suspense>
      ) : showSessionContent && currentSessionId ? (
        <ChatView
          sessionId={currentSessionId}
          onRegisterSearchOpen={handleRegisterSearchOpen}
          displayMode={displayMode}
          turnPaginationEnabled={paginationEnabled}
          position={position}
        />
      ) : (
        emptyChatContent
      )}
      {showEmptyChatFocusRestoreButton && (
        <div className="pointer-events-none absolute inset-x-0 bottom-8 z-10 flex justify-center px-4">
          <Tooltip
            content={chatFocusTooltip}
            position="top"
            mouseEnterDelay={200}
            framedPanel
          >
            <span className="pointer-events-auto inline-flex">
              <Button
                htmlType="button"
                variant="secondary"
                appearance="outline"
                size="default"
                shape="round"
                onClick={handleChatFocusToggle}
                aria-label={chatFocusLabel}
                icon={<GalleryThumbnails size={15} strokeWidth={2} />}
              >
                {chatFocusLabel}
              </Button>
            </span>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

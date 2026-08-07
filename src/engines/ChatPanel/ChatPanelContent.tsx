import { useAtomValue } from "jotai";
import React, { Suspense } from "react";

import { chatStatusBarVisibleAtom } from "@src/store/ui/chatPanelAtom";
import type {
  ChatHistoryDisplayMode,
  ChatPanelSelectedCloudOrg,
  ChatPanelSelectedProject,
  ChatPanelSelectedProjectOrg,
  ChatPanelSelectedWorkItem,
  ChatPanelSelectedWorkspace,
} from "@src/store/ui/chatPanelAtom";

import ChatView from "./ChatView";
import ChatStatusBar from "./components/ChatStatusBar";

const BenchmarkPanel = React.lazy(() =>
  import("@src/features/BenchmarkPanel").then((module) => ({
    default: module.BenchmarkPanel,
  }))
);
const CloudOrgPanelView = React.lazy(
  () => import("./panels/CloudOrgPanelView")
);
const ProjectOrgPanelView = React.lazy(
  () => import("./panels/ProjectOrgPanelView")
);
const ProjectPanelView = React.lazy(() => import("./panels/ProjectPanelView"));
const WorkItemPanelView = React.lazy(
  () => import("./panels/WorkItemPanelView")
);
const WorkspaceExplorePanelView = React.lazy(
  () => import("./panels/WorkspaceExplorePanelView")
);
const WorkspaceOverviewPanelView = React.lazy(
  () => import("./panels/WorkspaceOverviewPanelView")
);

interface ChatPanelContentProps {
  currentSessionId: string | null;
  emptyChatContent: React.ReactNode;
  handleRegisterSearchOpen: (handler: (() => void) | null) => void;
  displayMode: ChatHistoryDisplayMode;
  paginationEnabled: boolean;
  position: "left" | "right";
  selectedCloudOrg: ChatPanelSelectedCloudOrg | null;
  selectedProject: ChatPanelSelectedProject | null;
  selectedProjectOrg: ChatPanelSelectedProjectOrg | null;
  selectedWorkItem: ChatPanelSelectedWorkItem | null;
  selectedWorkspace: ChatPanelSelectedWorkspace | null;
  showBenchmarkSessionGroupContent: boolean;
  showCloudOrgContent: boolean;
  showExploreContent: boolean;
  showPanelContent: boolean;
  showProjectContent: boolean;
  showProjectOrgContent: boolean;
  showSessionContent: boolean;
  showWorkItemContent: boolean;
  showWorkspaceOverviewContent: boolean;
}

export function ChatPanelContent({
  currentSessionId,
  emptyChatContent,
  handleRegisterSearchOpen,
  displayMode,
  paginationEnabled,
  position,
  selectedCloudOrg,
  selectedProject,
  selectedProjectOrg,
  selectedWorkItem,
  selectedWorkspace,
  showBenchmarkSessionGroupContent,
  showCloudOrgContent,
  showExploreContent,
  showPanelContent,
  showProjectContent,
  showProjectOrgContent,
  showSessionContent,
  showWorkItemContent,
  showWorkspaceOverviewContent,
}: ChatPanelContentProps): React.ReactNode {
  const statusBarVisible = useAtomValue(chatStatusBarVisibleAtom);

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
      ) : showExploreContent ? (
        <Suspense fallback={null}>
          <WorkspaceExplorePanelView />
        </Suspense>
      ) : showCloudOrgContent && selectedCloudOrg ? (
        <Suspense fallback={null}>
          <CloudOrgPanelView selectedCloudOrg={selectedCloudOrg} />
        </Suspense>
      ) : showWorkspaceOverviewContent && selectedWorkspace ? (
        <Suspense fallback={null}>
          <WorkspaceOverviewPanelView selectedWorkspace={selectedWorkspace} />
        </Suspense>
      ) : showSessionContent && currentSessionId ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col">
            <ChatView
              sessionId={currentSessionId}
              onRegisterSearchOpen={handleRegisterSearchOpen}
              displayMode={displayMode}
              turnPaginationEnabled={paginationEnabled}
              position={position}
            />
          </div>
          {statusBarVisible && <ChatStatusBar sessionId={currentSessionId} />}
        </>
      ) : (
        emptyChatContent
      )}
    </div>
  );
}

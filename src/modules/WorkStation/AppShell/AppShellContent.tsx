import { useAtomValue } from "jotai";
import React, { Suspense } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import {
  activeWorkStationTabAtom,
  mainPaneTabsAtom,
} from "@src/store/workstation/tabs";

import CodeEditor from "../CodeEditor";
import { LspInstallPrompt } from "../CodeEditor/LspInstallPrompt";
import { WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS } from "../shared/tokens";
import { WorkStationStartPage } from "./StartPage";

const ProjectManagerCore = React.lazy(
  () =>
    import(
      /* webpackChunkName: "project-manager" */ "../../ProjectManager/ProjectManagerCore"
    )
);
const Browser = React.lazy(() => import("../Browser"));
const ActivitySimulator = React.lazy(() =>
  import("@src/engines/Simulator").then((module) => ({
    default: module.ActivitySimulator,
  }))
);

interface AppShellContentProps {
  repoPath: string;
  repoName: string;
  pathExists: boolean | null;
  lastSeenPath: string;
  isActive: boolean;
  chatPanelFocused: boolean;
  isAgentStation: boolean;
  hasVisitedAgentStation: boolean;
  hasVisitedCode: boolean;
  hasVisitedBrowser: boolean;
  hasVisitedProject: boolean;
  isCodeMode: boolean;
  isBrowserMode: boolean;
  isProjectMode: boolean;
  codeContentVisible: boolean;
  browserContentVisible: boolean;
  projectContentVisible: boolean;
  handleSelectRepo: () => void;
}

function AppShellLoadingPlaceholder() {
  return (
    <Placeholder
      variant="loading"
      placement="detail-panel"
      fillParentHeight
      className={WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS}
    />
  );
}

export function AppShellContent({
  repoPath,
  repoName,
  pathExists,
  lastSeenPath,
  isActive,
  chatPanelFocused,
  isAgentStation,
  hasVisitedAgentStation,
  hasVisitedCode,
  hasVisitedBrowser,
  hasVisitedProject,
  isCodeMode,
  isBrowserMode,
  isProjectMode,
  codeContentVisible,
  browserContentVisible,
  projectContentVisible,
  handleSelectRepo,
}: AppShellContentProps) {
  const { t } = useTranslation();
  const activeTab = useAtomValue(activeWorkStationTabAtom);
  const noTabs = useAtomValue(mainPaneTabsAtom).length === 0;
  // The Browser host is pinned outside the `mainPane` pool, so when it's the
  // active surface the pool can still read as "start"/empty — don't let the
  // launcher paint over it.
  const showStartPage =
    !isBrowserMode && (activeTab?.type === "start" || noTabs);
  const activeTabCanRenderWithoutRepo =
    activeTab?.type === "agent-config" ||
    activeTab?.type === "chat-session" ||
    activeTab?.type === "subagent-detail";

  const renderCodeEditor = () => {
    if (
      pathExists === false &&
      lastSeenPath &&
      !activeTabCanRenderWithoutRepo
    ) {
      return (
        <Placeholder
          variant="error"
          placement="detail-panel"
          fillParentHeight
          className={WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS}
          title={t("placeholders.cannotFindRepo", { repoName })}
          subtitle={t("placeholders.lastSeenAtPath", { path: lastSeenPath })}
          action={{
            label: t("actions.selectRepository"),
            onClick: handleSelectRepo,
          }}
        />
      );
    }

    return (
      <CodeEditor
        repoPath={repoPath}
        repoName={repoName}
        isActive={codeContentVisible}
      />
    );
  };

  return (
    <>
      {(isAgentStation || hasVisitedAgentStation) && (
        <div
          className="h-full w-full"
          style={{
            display: isAgentStation && !chatPanelFocused ? "block" : "none",
          }}
        >
          <Suspense fallback={<AppShellLoadingPlaceholder />}>
            <ActivitySimulator />
          </Suspense>
        </div>
      )}

      <div
        className="h-full w-full"
        style={{ display: isAgentStation ? "none" : "contents" }}
      >
        {/*
          Empty-pool start page. The hosts below stay MOUNTED (hidden) even
          when the launcher is showing so their side effects keep running —
          in particular the Browser host owns the new-session effect that
          turns a "New Browser Tab" request into a live session. We toggle
          visibility against the start page rather than unmounting them.
        */}
        {!isAgentStation && (
          <div
            className="h-full w-full"
            style={{ display: showStartPage ? "block" : "none" }}
          >
            <WorkStationStartPage />
          </div>
        )}
        {(isCodeMode || hasVisitedCode) && (
          <div
            className="relative h-full w-full"
            data-tour-target={CODE_EDITOR_TOUR_TARGETS.editorSurface}
            style={{
              display: !showStartPage && codeContentVisible ? "block" : "none",
            }}
          >
            {renderCodeEditor()}
            {!showStartPage &&
              codeContentVisible &&
              isActive &&
              !isAgentStation && <LspInstallPrompt />}
          </div>
        )}

        {(isBrowserMode || hasVisitedBrowser) && (
          <div
            className="h-full w-full"
            style={{
              display:
                !showStartPage && browserContentVisible ? "block" : "none",
            }}
          >
            <Suspense fallback={<AppShellLoadingPlaceholder />}>
              <Browser
                repoPath={repoPath}
                repoName={repoName}
                isActive={isActive && !showStartPage && browserContentVisible}
              />
            </Suspense>
          </div>
        )}

        {(isProjectMode || hasVisitedProject) && (
          <div
            className="h-full w-full"
            style={{
              display:
                !showStartPage && projectContentVisible ? "block" : "none",
            }}
          >
            <Suspense fallback={<AppShellLoadingPlaceholder />}>
              <ProjectManagerCore repoPath={repoPath} repoName={repoName} />
            </Suspense>
          </div>
        )}
      </div>
    </>
  );
}

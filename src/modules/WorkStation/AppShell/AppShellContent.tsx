import { useAtomValue } from "jotai";
import React, { Suspense } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import { activeWorkStationTabAtom } from "@src/store/workstation/tabs";

import CodeEditor from "../CodeEditor";
import { LspInstallPrompt } from "../CodeEditor/LspInstallPrompt";
import { WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS } from "../shared/tokens";

const ProjectManagerCore = React.lazy(
  () =>
    import(
      /* webpackChunkName: "project-manager" */ "../../ProjectManager/ProjectManagerCore"
    )
);
const Browser = React.lazy(() => import("../Browser"));
const DatabaseManager = React.lazy(() => import("../DatabaseManager"));
const OpsControl = React.lazy(() => import("@src/modules/MainApp/OpsControl"));
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
  isOpsControlStation: boolean;
  opsControlPeekHost: "code" | "browser" | "data" | "project" | null;
  hasVisitedAgentStation: boolean;
  hasVisitedOpsControlStation: boolean;
  hasVisitedCode: boolean;
  hasVisitedData: boolean;
  hasVisitedBrowser: boolean;
  hasVisitedProject: boolean;
  isCodeMode: boolean;
  isDataMode: boolean;
  isBrowserMode: boolean;
  isProjectMode: boolean;
  codeContentVisible: boolean;
  browserContentVisible: boolean;
  dataContentVisible: boolean;
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
  isOpsControlStation,
  opsControlPeekHost,
  hasVisitedAgentStation,
  hasVisitedOpsControlStation,
  hasVisitedCode,
  hasVisitedData,
  hasVisitedBrowser,
  hasVisitedProject,
  isCodeMode,
  isDataMode,
  isBrowserMode,
  isProjectMode,
  codeContentVisible,
  browserContentVisible,
  dataContentVisible,
  projectContentVisible,
  handleSelectRepo,
}: AppShellContentProps) {
  const { t } = useTranslation();
  const activeTab = useAtomValue(activeWorkStationTabAtom);
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

      {(isOpsControlStation || hasVisitedOpsControlStation) && (
        <div
          className="h-full w-full"
          style={{
            display:
              isOpsControlStation && opsControlPeekHost === null
                ? "block"
                : "none",
          }}
        >
          <Suspense fallback={<AppShellLoadingPlaceholder />}>
            <OpsControl />
          </Suspense>
        </div>
      )}

      <div
        className="h-full w-full"
        style={{
          display:
            isAgentStation ||
            (isOpsControlStation && opsControlPeekHost === null)
              ? "none"
              : "contents",
        }}
      >
        {(isCodeMode || hasVisitedCode || opsControlPeekHost === "code") && (
          <div
            className="relative h-full w-full"
            data-tour-target={CODE_EDITOR_TOUR_TARGETS.editorSurface}
            style={{ display: codeContentVisible ? "block" : "none" }}
          >
            {renderCodeEditor()}
            {codeContentVisible && isActive && !isAgentStation && (
              <LspInstallPrompt />
            )}
          </div>
        )}

        {(isDataMode || hasVisitedData) && (
          <div
            className="h-full w-full"
            style={{ display: dataContentVisible ? "block" : "none" }}
          >
            <Suspense fallback={<AppShellLoadingPlaceholder />}>
              <DatabaseManager repoPath={repoPath} repoName={repoName} />
            </Suspense>
          </div>
        )}

        {(isBrowserMode || hasVisitedBrowser) && (
          <div
            className="h-full w-full"
            style={{ display: browserContentVisible ? "block" : "none" }}
          >
            <Suspense fallback={<AppShellLoadingPlaceholder />}>
              <Browser
                repoPath={repoPath}
                repoName={repoName}
                isActive={isActive && browserContentVisible}
              />
            </Suspense>
          </div>
        )}

        {(isProjectMode || hasVisitedProject) && (
          <div
            className="h-full w-full"
            style={{ display: projectContentVisible ? "block" : "none" }}
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

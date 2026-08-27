import { useAtomValue } from "jotai";
import React, { Suspense } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { useBrowserContextOptional } from "@src/contexts/workstation/BrowserContext";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import {
  mainPaneHasBrowserHostTabsAtom,
  mainPaneHasRealTabsAtom,
} from "@src/store/workstation/tabHost";
import {
  activeWorkStationTabAtom,
  mainPaneTabsAtom,
} from "@src/store/workstation/tabs";
import {
  workstationNewBrowserSessionConsumedTickAtom,
  workstationNewBrowserSessionRequestAtom,
} from "@src/store/workstation/workstationTabBarAtoms";

import CodeEditor from "../CodeEditor";
import { WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS } from "../shared/tokens";
import { WorkStationStartPage } from "./StartPage";
import {
  shouldMountAgentStationHost,
  shouldMountBrowserHost,
  shouldMountWorkstationHost,
} from "./hostMountPolicy";

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
  /** Whether Agent Station has a live session attached (keep-alive gate). */
  hasAgentStationSession: boolean;
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
  hasAgentStationSession,
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

  // ── Host mount policy ────────────────────────────────────────────────
  // Bounded keep-alive: hosts stay mounted (hidden) between real tabs so
  // switches are instant, but the empty Launchpad releases every host — see
  // `hostMountPolicy.ts`. The Browser host has extra mount triggers because
  // it owns side effects the other hosts don't: the new-session request
  // consumer (consumed-tick effect in BrowserLayout, which is remount-safe)
  // and the engine-sessions ↔ tab-strip sync.
  const hasRealTabs = useAtomValue(mainPaneHasRealTabsAtom);
  const hasBrowserHostTabs = useAtomValue(mainPaneHasBrowserHostTabsAtom);
  const newBrowserSessionRequest = useAtomValue(
    workstationNewBrowserSessionRequestAtom
  );
  const newBrowserSessionConsumedTick = useAtomValue(
    workstationNewBrowserSessionConsumedTickAtom
  );
  // Optional: AppShellContent always sits under BrowserProvider in the app,
  // but isolated mounts (tests) shouldn't crash — no provider ⇒ no sessions.
  const browserContextValue = useBrowserContextOptional();
  const mountAgentStationHost = shouldMountAgentStationHost({
    isAgentStation,
    hasVisited: hasVisitedAgentStation,
    hasActiveSession: hasAgentStationSession,
  });
  const mountCodeHost = shouldMountWorkstationHost({
    hasRealTabs,
    isActiveHost: isCodeMode,
    hasVisited: hasVisitedCode,
  });
  const mountProjectHost = shouldMountWorkstationHost({
    hasRealTabs,
    isActiveHost: isProjectMode,
    hasVisited: hasVisitedProject,
  });
  const mountBrowserHost = shouldMountBrowserHost({
    hasRealTabs,
    isActiveHost: isBrowserMode,
    hasVisited: hasVisitedBrowser,
    hasBrowserHostTabs,
    hasBrowserSessions: (browserContextValue?.sessions.length ?? 0) > 0,
    hasPendingNewSessionRequest:
      newBrowserSessionRequest.tick > newBrowserSessionConsumedTick,
  });
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
      {mountAgentStationHost && (
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
          Empty-pool start page. While it shows, no host is mounted at all
          (see the mount policy above) — the empty pool has nothing to keep
          warm, and cross-surface requests (e.g. "New Browser Tab") travel
          through remount-safe atoms that mount their host on demand. While
          real tabs exist, visited hosts stay mounted (hidden) so tab
          switches are instant.
        */}
        {!isAgentStation && showStartPage && (
          <div className="h-full w-full">
            <WorkStationStartPage />
          </div>
        )}
        {mountCodeHost && (
          <div
            className="relative h-full w-full"
            data-tour-target={CODE_EDITOR_TOUR_TARGETS.editorSurface}
            style={{
              display: !showStartPage && codeContentVisible ? "block" : "none",
            }}
          >
            {renderCodeEditor()}
          </div>
        )}

        {mountBrowserHost && (
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

        {mountProjectHost && (
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

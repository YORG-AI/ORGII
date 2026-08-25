/**
 * Orgii Main Layout Component
 *
 * Orchestrates providers and delegates layout to AppLayout.
 * All layout logic consolidated in layouts/shared/AppLayout.tsx
 *
 * The router mounts this shell only for WorkStation and Settings routes.
 * WorkStation remains mounted while Settings occupies the chat-panel slot.
 *
 * Performance:
 * - SidebarSelector: DYNAMIC layer - changes per route
 * - ChatPanel: STABLE layer - stays mounted across Workbench routes
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import {
  HOST_DESKTOP,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { BrowserProvider, TerminalProvider } from "@src/contexts/workstation";
import { useViewportWidth } from "@src/engines/ChatPanel/hooks/useViewportWidth";
import { useAgentADEActions } from "@src/engines/SessionCore/hooks/useAgentADEActions";
import { useProjectDataChangedListener } from "@src/hooks/project";
import { useUrlPreviewEvents } from "@src/hooks/tabHost/useUrlPreviewEvents";
import { useBackgroundImage } from "@src/hooks/theme/useBackgroundImage";
import { useGlobalBrowserWebviewLayering } from "@src/modules/WorkStation/Browser/hooks";
import { CODE_EDITOR_TOUR_EVENT } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import {
  GENERAL_LAYOUT_TOUR_EVENT,
  GENERAL_LAYOUT_TOUR_TARGETS,
} from "@src/scaffold/Tutorials/generalLayoutTourConfig";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import { TUTORIALS_OPEN_EVENT } from "@src/scaffold/Tutorials/tutorialRegistry";
import { resolvedBackgroundConfigAtom } from "@src/store";
import {
  activeChatPanelTabAtom,
  resolveChatPanelMaximizedForLayout,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { useSyncStatusBridge } from "@src/store/sync";
import {
  type ChatPanelMode,
  chatPanelMaximizedAtom,
  chatWidthAtom,
  restoreChatWidthAtom,
  stationChatVisibilityAtom,
} from "@src/store/ui/chatPanelAtom";
import { settingsReturnPathAtom } from "@src/store/ui/settingsNavigationAtom";
import {
  DEFAULT_SIDEBAR_WIDTH,
  sidebarCollapsedAtom,
  sidebarWidthAtom,
} from "@src/store/ui/sidebarAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  sessionChatPositionAtom,
  workStationChatPositionAtom,
} from "@src/store/ui/workStationAtom";
import { prewarmColor } from "@src/util/ui/theme/glassMaterial";

// Deep import, not the `./shared/components` barrel: the barrel re-exports
// MarkdownContent, which pulls the Markdown renderer (and with it
// react-markdown + the Prism grammar set) into the pre-paint startup graph.
// `src/app/root/__tests__/startupGraph.test.ts` pins this.
import { BackgroundLayer } from "./shared/components/BackgroundLayer";
import { FloatingSidebar } from "./shared/components/FloatingSidebar";
import { SidebarSelector } from "./shared/components/SidebarSelector";
import { useRouteLayoutType, useWorkspaceEvents } from "./shared/hooks";
import { AppLayout } from "./shared/layouts";
import { useNarrowChatFocus } from "./useNarrowChatFocus";
import { useOpenUrlInBrowser } from "./useOpenUrlInBrowser";
import { useWorkStationPipelineBridge } from "./useWorkStationPipelineBridge";

const WorkStationPage = React.lazy(
  () => import(/* webpackChunkName: "workstation" */ "@src/modules/WorkStation")
);

const SharedBrowserApp = React.lazy(
  () =>
    import(
      /* webpackChunkName: "browser-shared" */ "@src/modules/WorkStation/Browser/shared/SharedBrowserApp"
    )
);

const GuideHighlightOverlay = React.lazy(
  () =>
    import(
      /* webpackChunkName: "tutorials" */ "@src/scaffold/Tutorials/GuideHighlightOverlay"
    )
);

const TutorialsModal = React.lazy(
  () =>
    import(
      /* webpackChunkName: "tutorials" */ "@src/scaffold/Tutorials/TutorialsModal"
    )
);

const GeneralLayoutTour = React.lazy(
  () =>
    import(
      /* webpackChunkName: "tutorials" */ "@src/scaffold/Tutorials/GeneralLayoutTour"
    )
);

const CodeEditorTour = React.lazy(
  () =>
    import(
      /* webpackChunkName: "tutorials" */ "@src/scaffold/Tutorials/CodeEditorTour"
    )
);

/**
 * Main Orgii Component
 *
 * Performance Architecture:
 * 1. SidebarSelector: DYNAMIC (changes per route, memoized)
 * 2. WorkStation: PERSISTENT while the Workbench route branch is mounted
 *
 * This ensures:
 * - WorkStation stays mounted across WorkStation and Settings route switches
 */

/** Mounts useOpenUrlInBrowser inside BrowserProvider so the hook can access BrowserContext. */
const BrowserEventBridge: React.FC = () => {
  useOpenUrlInBrowser();
  return null;
};

const WorkStationLoadingFallback: React.FC = () => (
  <div className="h-full w-full bg-workstation-bg" />
);

const HOST_DESKTOP_VALUE = resolveHostDesktop();
const HOST_USES_NATIVE_BACKDROP =
  HOST_DESKTOP_VALUE === HOST_DESKTOP.MACOS ||
  HOST_DESKTOP_VALUE === HOST_DESKTOP.WINDOWS;

/** Legacy wallpaper/color background, retained for browser and Linux hosts. */
const ConfiguredBackgroundLayer: React.FC = () => {
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const currentBackgroundImage = useBackgroundImage();

  useEffect(() => {
    if (!backgroundConfig.backgroundColor) return;
    prewarmColor(backgroundConfig.backgroundColor);
  }, [backgroundConfig.backgroundColor]);

  return (
    <BackgroundLayer
      image={backgroundConfig.backgroundColor ? null : currentBackgroundImage}
      blurAmount={backgroundConfig.blurAmount ?? 0}
      backgroundColor={backgroundConfig.backgroundColor}
      glass={backgroundConfig.glass}
    />
  );
};

const AppShell = () => {
  const location = useLocation();

  // === Global Browser Webview Layering ===
  // Drops inline browser WKWebViews behind React portals whenever any
  // overlay (dropdown, modal, spotlight) is visible. See
  // `docs/workstation/Browser/webview-layering--0418.md`.
  useGlobalBrowserWebviewLayering();

  const navigate = useNavigate();

  useWorkspaceEvents();
  useUrlPreviewEvents();

  // === OS Agent IDE Actions Bridge ===
  // Still mounted because `manage_session` Rust tool routes through the
  // ActionBridge for session-category zod actions (session.create /
  // session.list / session.sendMessage / ...). GUI-category actions are
  // gated off inside the hook — see GUI_DISPATCH_DISABLED in
  // useOSAgentIDEActions.ts. Re-enable GUI routing for cowork / voice mode.
  useAgentADEActions();

  // === Listens for project/work-item data-change events from the Rust
  // backend (project_management::projects::events) so cached views invalidate
  // and atoms re-fetch without a manual refresh.
  useProjectDataChangedListener();

  // === Phase 4.6 Track B: live outbox-state events from the sync worker
  // (project_management::sync::events). Replaces polling
  // `projectSyncApi.status` from the settings panel + status bar.
  useSyncStatusBridge();

  const stationMode = useAtomValue(stationModeAtom);
  const chatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  const viewportWidth = useViewportWidth();
  const stationChatVisibility = useAtomValue(stationChatVisibilityAtom);
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const routeLayoutType = useRouteLayoutType();
  const currentStationChatVisible =
    stationMode in stationChatVisibility
      ? stationChatVisibility[stationMode as keyof typeof stationChatVisibility]
      : false;
  const setChatWidth = useSetAtom(chatWidthAtom);
  const restoreChatWidth = useSetAtom(restoreChatWidthAtom);
  const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const setStationChatVisibility = useSetAtom(stationChatVisibilityAtom);
  const setSettingsReturnPath = useSetAtom(settingsReturnPathAtom);
  const [tutorialsModalOpen, setTutorialsModalOpen] = useState(false);
  const [generalLayoutTourOpen, setGeneralLayoutTourOpen] = useState(false);
  const [generalLayoutTourRunId, setGeneralLayoutTourRunId] = useState(0);
  const [codeEditorTourOpen, setCodeEditorTourOpen] = useState(false);
  const [codeEditorTourRunId, setCodeEditorTourRunId] = useState(0);

  // Settings-in-slot is fully URL-derived: any `/orgii/app/settings/*`
  // path swaps the chat-panel slot to render the Settings dispatcher
  // instead of the live session, and pins it to the left side of the
  // WorkStation. The slot itself fans out by route root (APP /
  // AGENT_ORGS / MY_ROLE) — from AppShell's perspective all settings
  // URLs look the same. There is no atom for this; the URL is the
  // single source of truth.
  const isSettingsRoute = location.pathname.startsWith("/orgii/app/settings");
  const chatPanelMode: ChatPanelMode = isSettingsRoute ? "settings" : "session";

  useEffect(() => {
    if (!location.pathname.startsWith(ROUTES.workStation.base.path)) return;
    setSettingsReturnPath(`${location.pathname}${location.search}`);
  }, [location.pathname, location.search, setSettingsReturnPath]);

  const handleOpenTutorials = useCallback(() => {
    setTutorialsModalOpen(true);
  }, []);

  const handleStartGeneralLayoutTour = useCallback(() => {
    if (!location.pathname.startsWith(ROUTES.workStation.base.path)) {
      navigate(ROUTES.workStation.base.path);
    }

    setStationMode("my-station");
    setChatPanelMaximized(false);
    setSidebarCollapsed(false);
    setStationChatVisibility((prev) => ({
      ...prev,
      "my-station": true,
    }));
    restoreChatWidth();
    setGeneralLayoutTourRunId((value) => value + 1);
    window.setTimeout(() => setGeneralLayoutTourOpen(true), 220);
  }, [
    location.pathname,
    navigate,
    restoreChatWidth,
    setChatPanelMaximized,
    setSidebarCollapsed,
    setStationChatVisibility,
    setStationMode,
  ]);

  const handleStartCodeEditorTour = useCallback(() => {
    if (!location.pathname.startsWith(ROUTES.workStation.code.path)) {
      navigate(ROUTES.workStation.code.path);
    }

    setStationMode("my-station");
    setChatPanelMaximized(false);
    setSidebarCollapsed(false);
    setStationChatVisibility((prev) => ({
      ...prev,
      "my-station": true,
    }));
    restoreChatWidth();
    setCodeEditorTourRunId((value) => value + 1);
    window.setTimeout(() => setCodeEditorTourOpen(true), 240);
  }, [
    location.pathname,
    navigate,
    restoreChatWidth,
    setChatPanelMaximized,
    setSidebarCollapsed,
    setStationChatVisibility,
    setStationMode,
  ]);

  useEffect(() => {
    window.addEventListener(TUTORIALS_OPEN_EVENT, handleOpenTutorials);
    window.addEventListener(
      GENERAL_LAYOUT_TOUR_EVENT,
      handleStartGeneralLayoutTour
    );
    window.addEventListener(CODE_EDITOR_TOUR_EVENT, handleStartCodeEditorTour);
    return () => {
      window.removeEventListener(TUTORIALS_OPEN_EVENT, handleOpenTutorials);
      window.removeEventListener(
        GENERAL_LAYOUT_TOUR_EVENT,
        handleStartGeneralLayoutTour
      );
      window.removeEventListener(
        CODE_EDITOR_TOUR_EVENT,
        handleStartCodeEditorTour
      );
    };
  }, [
    handleOpenTutorials,
    handleStartCodeEditorTour,
    handleStartGeneralLayoutTour,
  ]);

  useEffect(() => {
    if (chatPanelMaximized) return;
    // Don't touch chat width while Settings-in-slot owns the slot — its
    // own fallback width (DEFAULT_CHAT_WIDTH) shouldn't be overwritten.
    if (isSettingsRoute) return;

    if (currentStationChatVisible) {
      restoreChatWidth();
    } else {
      setChatWidth(0);
    }
  }, [
    chatPanelMaximized,
    currentStationChatVisible,
    isSettingsRoute,
    restoreChatWidth,
    setChatWidth,
  ]);

  // Auto-maximize the chat-panel slot when the user navigates into
  // Settings, and restore the prior state when they leave — unless they
  // manually toggle maximize while in Settings, in which case respect
  // their choice on exit. Edge-triggered: only fires on the
  // session→settings and settings→session transitions, so re-rendering
  // inside settings doesn't keep re-forcing maximized.
  //
  // Uses `useLayoutEffect` so the atom write commits BEFORE the browser
  // paints the new route. Otherwise the first paint after navigating
  // into Settings briefly shows the un-maximized layout (WorkStation
  // surface visible behind the not-yet-full-width Settings slot) for one
  // frame before the post-paint effect maximizes the slot — visible as a
  // flash of WorkStation content on entry.
  const settingsPriorMaximizedRef = useRef<boolean | null>(null);
  // Initialize to `false` so the very first paint into a settings URL
  // (cold start / deep link / reload mid-session) also trips the
  // session→settings edge and auto-maximizes. After the first effect
  // run this ref tracks the live previous value.
  const wasSettingsRouteRef = useRef<boolean>(false);
  useLayoutEffect(() => {
    const wasSettings = wasSettingsRouteRef.current;
    wasSettingsRouteRef.current = isSettingsRoute;
    // Use the render-time value directly (it is captured at the point
    // this effect runs, which is the same frame as the route change).
    const live = chatPanelMaximized;

    if (isSettingsRoute && !wasSettings) {
      settingsPriorMaximizedRef.current = live;
      if (!live) setChatPanelMaximized(true);
      return;
    }

    if (!isSettingsRoute && wasSettings) {
      const prior = settingsPriorMaximizedRef.current;
      settingsPriorMaximizedRef.current = null;
      if (prior !== null && prior !== live) {
        setChatPanelMaximized(prior);
      }
    }
  }, [chatPanelMaximized, isSettingsRoute, setChatPanelMaximized]);

  const activeChatPanelTab = useAtomValue(activeChatPanelTabAtom);
  // Only a visible primary Session tab may restore WorkStation memory into the
  // live pipeline. Launchpad and management tabs deliberately release it.
  const shouldBridgeWorkStationPipeline =
    !isSettingsRoute && activeChatPanelTab?.type === "session";

  useNarrowChatFocus({ enabled: true });
  useWorkStationPipelineBridge(shouldBridgeWorkStationPipeline);

  const workStationChatPosition = useAtomValue(workStationChatPositionAtom);
  const sessionChatPosition = useAtomValue(sessionChatPositionAtom);
  // Settings always sits on the left; position atoms describe ChatPanel placement only.
  const chatPosition = isSettingsRoute
    ? "left"
    : stationMode === "agent-station"
      ? sessionChatPosition
      : workStationChatPosition;
  const sessionSidebarWidth =
    routeLayoutType === "session" && !sidebarCollapsed
      ? sidebarWidth || DEFAULT_SIDEBAR_WIDTH
      : 0;

  const effectiveChatFocus = resolveChatPanelMaximizedForLayout(
    chatPanelMaximized,
    activeChatPanelTab,
    viewportWidth
  );

  return (
    <TerminalProvider>
      <BrowserProvider>
        <BrowserEventBridge />
        <Outlet />
        <React.Suspense fallback={null}>
          <SharedBrowserApp />
        </React.Suspense>
        <div
          className="relative flex h-full"
          data-guide-target={GUIDE_TARGETS.APP_ROOT}
        >
          {!HOST_USES_NATIVE_BACKDROP && <ConfiguredBackgroundLayer />}

          {/* Main layout with sidebar, toolbar, content, and chat panel */}
          <AppLayout
            viewportWidth={viewportWidth}
            sidebar={<SidebarSelector />}
            floatingSidebar={<FloatingSidebar />}
            showChatPanel
            chatPosition={chatPosition}
            chatPanelMaximized={effectiveChatFocus}
            chatPanelMode={chatPanelMode}
            sessionSidebarWidth={sessionSidebarWidth}
          >
            <div className="relative h-full w-full min-w-0">
              <div
                className="absolute inset-0 bg-workstation-bg"
                data-guide-target={GUIDE_TARGETS.WORKSTATION}
                data-tour-target={GENERAL_LAYOUT_TOUR_TARGETS.workstation}
              >
                <React.Suspense fallback={<WorkStationLoadingFallback />}>
                  <WorkStationPage
                    isActive
                    chatPanelFocused={effectiveChatFocus}
                  />
                </React.Suspense>
              </div>
            </div>
          </AppLayout>
          <React.Suspense fallback={null}>
            <GuideHighlightOverlay />
            <TutorialsModal
              open={tutorialsModalOpen}
              onClose={() => setTutorialsModalOpen(false)}
            />
            <GeneralLayoutTour
              key={`general-layout-tour-${generalLayoutTourRunId}`}
              open={generalLayoutTourOpen}
              onClose={() => setGeneralLayoutTourOpen(false)}
            />
            <CodeEditorTour
              key={`code-editor-tour-${codeEditorTourRunId}`}
              open={codeEditorTourOpen}
              onClose={() => setCodeEditorTourOpen(false)}
            />
          </React.Suspense>
        </div>
      </BrowserProvider>
    </TerminalProvider>
  );
};

export default AppShell;

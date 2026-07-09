/**
 * Orgii Main Layout Component
 *
 * Orchestrates providers and delegates layout to AppLayout.
 * All layout logic consolidated in layouts/shared/AppLayout.tsx
 *
 * CRITICAL ARCHITECTURE for View Mode Persistence:
 * - WorkStation (Workstation view): Always mounted, visibility controlled by CSS
 *   (includes Code Editor, Browser, Database, Chat, Project Manager)
 * - MainApp: Rendered via Outlet (route-based)
 * - This ensures WorkStation state survives view mode switches
 *
 * Performance:
 * - SidebarSelector: DYNAMIC layer - changes per route
 * - ChatPanel: STABLE layer - stays mounted across view switches
 */
import { registerAppActions } from "@/src/ActionSystem/registerAppActions";
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { useRouteViewMode } from "@src/config/routeViewModeConfig";
import { ROUTES } from "@src/config/routes";
import { BrowserProvider, TerminalProvider } from "@src/contexts/workstation";
import { useAgentADEActions } from "@src/engines/SessionCore/hooks/useAgentADEActions";
import { useProjectDataChangedListener } from "@src/hooks/project";
import { useBackgroundImage } from "@src/hooks/theme/useBackgroundImage";
import { useOpenUrlInBrowser } from "@src/hooks/workStation/browser/useOpenUrlInBrowser";
import { useUrlPreviewEvents } from "@src/hooks/workStation/tabs";
import { useNarrowChatFocus } from "@src/hooks/workStation/useNarrowChatFocus";
import { useGlobalBrowserWebviewLayering } from "@src/modules/WorkStation/Browser/hooks";
import { CODE_EDITOR_TOUR_EVENT } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import {
  GENERAL_LAYOUT_TOUR_EVENT,
  GENERAL_LAYOUT_TOUR_TARGETS,
} from "@src/scaffold/Tutorials/generalLayoutTourConfig";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import { TUTORIALS_OPEN_EVENT } from "@src/scaffold/Tutorials/tutorialRegistry";
import { resolvedBackgroundConfigAtom } from "@src/store";
import { useSyncStatusBridge } from "@src/store/sync";
import {
  type ChatPanelMode,
  chatPanelMaximizedAtom,
  chatWidthAtom,
  restoreChatWidthAtom,
  stationChatVisibilityAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  DEFAULT_SIDEBAR_WIDTH,
  sidebarCollapsedAtom,
  sidebarWidthAtom,
} from "@src/store/ui/sidebarAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { globalLayoutMethodAtom } from "@src/store/ui/uiAtom";
import {
  sessionChatPositionAtom,
  workStationChatPositionAtom,
  workStationDockAutoHidePersistAtom,
} from "@src/store/ui/workStationAtom";
import { dockFilterAtom } from "@src/store/workstation";
import { prewarmColor } from "@src/util/ui/theme/glassMaterial";

import { BackgroundLayer } from "./shared/components";
import { FloatingSidebar } from "./shared/components/FloatingSidebar";
import { SidebarSelector } from "./shared/components/SidebarSelector";
import {
  useRouteLayoutType,
  useStickyMount,
  useWorkspaceEvents,
} from "./shared/hooks";
import { AppLayout } from "./shared/layouts";
import type { ChatLayout } from "./shared/layouts/AppLayout";
import {
  LAYOUT_CONTAIN_STYLE,
  VIEW_CONTAINER_CLASSES,
  getViewToggleStyle,
} from "./shared/layouts/viewContainerTokens";
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
 * View Mode Persistence Architecture:
 * - WorkStation (Workstation view): Always mounted, visibility controlled by CSS
 * - MainApp/other routes: Rendered via Outlet (route-based)
 *
 * Performance Architecture:
 * 1. SidebarSelector: DYNAMIC (changes per route, memoized)
 * 2. WorkStation: PERSISTENT (mounted once, visibility toggled)
 *
 * This ensures:
 * - WorkStation stays mounted across route switches
 * - WorkStation state survives view mode switches
 */

/** Mounts useOpenUrlInBrowser inside BrowserProvider so the hook can access BrowserContext. */
const BrowserEventBridge: React.FC = () => {
  useOpenUrlInBrowser();
  return null;
};

const WorkStationLoadingFallback: React.FC = () => (
  <div className="h-full w-full bg-workstation-bg" />
);

const AppShell = () => {
  const location = useLocation();

  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const currentBackgroundImage = useBackgroundImage();

  useEffect(() => {
    if (!backgroundConfig.backgroundColor) return;
    prewarmColor(backgroundConfig.backgroundColor);
  }, [backgroundConfig.backgroundColor]);

  const viewMode = useRouteViewMode();

  // === App-Level Action Registration ===
  // Registers navigation, theme, sidebar, tabs, spotlight actions globally
  // via zodActionRegistry — available to the OS agent and all components.
  useEffect(() => {
    const cleanup = registerAppActions();
    return cleanup;
  }, []);

  // === Global Browser Webview Layering ===
  // Drops inline browser WKWebViews behind React portals whenever any
  // overlay (dropdown, modal, spotlight) is visible. See
  // `docs/workstation/Browser/webview-layering--0418.md`.
  useGlobalBrowserWebviewLayering();

  // === Navigation Bridge ===
  // App-level navigation actions dispatch CustomEvents because they can't use
  // React Router hooks (they run outside component context). This listener
  // bridges the event to the real router.
  const navigate = useNavigate();
  useEffect(() => {
    function handleNavigate(evt: Event) {
      const { path, replace } = (
        evt as CustomEvent<{ path: string; replace?: boolean }>
      ).detail;
      navigate(path, { replace });
    }
    window.addEventListener("action-system-navigate", handleNavigate);
    return () => {
      window.removeEventListener("action-system-navigate", handleNavigate);
    };
  }, [navigate]);

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
  const setDockAutoHide = useSetAtom(workStationDockAutoHidePersistAtom);
  const setDockFilter = useSetAtom(dockFilterAtom);
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
    setDockAutoHide(false);
    setDockFilter("all");
    setGeneralLayoutTourRunId((value) => value + 1);
    window.setTimeout(() => setGeneralLayoutTourOpen(true), 220);
  }, [
    location.pathname,
    navigate,
    restoreChatWidth,
    setChatPanelMaximized,
    setDockAutoHide,
    setDockFilter,
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
    setDockAutoHide(false);
    setDockFilter("code");
    setCodeEditorTourRunId((value) => value + 1);
    window.setTimeout(() => setCodeEditorTourOpen(true), 240);
  }, [
    location.pathname,
    navigate,
    restoreChatWidth,
    setChatPanelMaximized,
    setDockAutoHide,
    setDockFilter,
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

  const showChatPanel = useMemo(() => {
    const path = location.pathname;
    // Settings-in-slot must stay visible even on Ops Control so the user can
    // open Settings from the Kanban surface without flipping out of it.
    if (isSettingsRoute) return true;
    if (stationMode === "ops-control") return false;
    return path.includes("/workstation");
  }, [location.pathname, isSettingsRoute, stationMode]);

  useEffect(() => {
    if (viewMode !== "workStation") return;
    if (chatPanelMaximized || stationMode === "ops-control") return;
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
    stationMode,
    viewMode,
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

  const globalLayoutMethod = useAtomValue(globalLayoutMethodAtom);

  // `/orgii/app/settings/*` resolves to `viewMode === "workStation"` (see routeViewModeConfig),
  // so this captures the settings surface too — no extra OR clause needed.
  const isWorkStationViewActive = viewMode === "workStation";
  // Skip bridging when Settings-in-slot is active — it doesn't run a real chat session.
  const shouldBridgeWorkStationPipeline =
    isWorkStationViewActive &&
    stationMode !== "ops-control" &&
    !isSettingsRoute;

  useNarrowChatFocus({ enabled: isWorkStationViewActive });
  useWorkStationPipelineBridge(shouldBridgeWorkStationPipeline);

  const shouldRenderWorkStation = useStickyMount(isWorkStationViewActive);
  // Settings-in-slot owns the slot while its route is active; the Outlet stays
  // mounted but hidden so deeplinks / refresh still work.
  const shouldShowOutlet = !isWorkStationViewActive;

  // GlobalLayoutMethod and ChatLayout unions match exactly, so the value passes through.
  const chatLayout: ChatLayout = isWorkStationViewActive
    ? globalLayoutMethod
    : "inset";

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

  // Ops Control suppresses overlay unless Settings-in-slot is active.
  const effectiveChatFocus =
    chatPanelMaximized &&
    isWorkStationViewActive &&
    (stationMode !== "ops-control" || isSettingsRoute);

  return (
    <TerminalProvider>
      <BrowserProvider>
        <BrowserEventBridge />
        <React.Suspense fallback={null}>
          <SharedBrowserApp />
        </React.Suspense>
        <div
          className="relative flex h-full"
          data-guide-target={GUIDE_TARGETS.APP_ROOT}
        >
          <BackgroundLayer
            image={
              backgroundConfig.backgroundColor ? null : currentBackgroundImage
            }
            blurAmount={backgroundConfig.blurAmount ?? 0}
            backgroundColor={backgroundConfig.backgroundColor}
            glass={backgroundConfig.glass}
          />

          {/* Main layout with sidebar, toolbar, content, and chat panel */}
          <AppLayout
            sidebar={<SidebarSelector />}
            floatingSidebar={<FloatingSidebar />}
            showChatPanel={showChatPanel}
            contentPadding={isWorkStationViewActive}
            chatLayout={chatLayout}
            chatPosition={chatPosition}
            chatPanelMaximized={effectiveChatFocus}
            chatPanelMode={chatPanelMode}
            sessionSidebarWidth={sessionSidebarWidth}
          >
            <div className="relative h-full w-full min-w-0">
              {/* WorkStation — deferred until first visit, then kept mounted */}
              {shouldRenderWorkStation && (
                <div
                  className={
                    globalLayoutMethod === "compact"
                      ? VIEW_CONTAINER_CLASSES.compactWithBg
                      : globalLayoutMethod === "full"
                        ? VIEW_CONTAINER_CLASSES.fullWithBg
                        : VIEW_CONTAINER_CLASSES.insetWithBg
                  }
                  style={getViewToggleStyle(isWorkStationViewActive)}
                  data-guide-target={
                    isWorkStationViewActive
                      ? GUIDE_TARGETS.WORKSTATION
                      : undefined
                  }
                  data-tour-target={
                    isWorkStationViewActive
                      ? GENERAL_LAYOUT_TOUR_TARGETS.workstation
                      : undefined
                  }
                >
                  <React.Suspense fallback={<WorkStationLoadingFallback />}>
                    <WorkStationPage
                      isActive={isWorkStationViewActive}
                      chatPanelFocused={effectiveChatFocus}
                      isFullMode={
                        globalLayoutMethod === "full" ||
                        globalLayoutMethod === "compact"
                      }
                    />
                  </React.Suspense>
                </div>
              )}

              <div
                className="h-full w-full min-w-0"
                style={{
                  ...getViewToggleStyle(shouldShowOutlet),
                  ...LAYOUT_CONTAIN_STYLE,
                }}
              >
                <Outlet />
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

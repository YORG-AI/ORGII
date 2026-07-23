import {
  activeSessionIdAtom,
  sessionMapAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import {
  activeChatPanelSurfaceAtom,
  chatPanelMaximizedAtom,
  chatVisibleAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { adeManagerEnabledAtom, spotlightOpenAtom } from "@src/store/ui/uiAtom";
import {
  activeStatusBarAppAtom,
  activeStatusBarStateAtom,
} from "@src/store/ui/workStationLayout/statusBarAtoms";
import { activeWorkStationTabAtom } from "@src/store/workstation/tabs";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import type { AppUiSnapshot, GuideTargetSnapshot } from "./workspaceSnapshot";

const GUIDE_TARGET_SELECTOR = "[data-guide-target],[data-tour-target]";

function getWindowLocationSnapshot(): AppUiSnapshot["route"] {
  if (typeof window === "undefined") return undefined;
  const { pathname, search, hash, href } = window.location;
  return {
    pathname,
    search,
    hash,
    href,
  };
}

function getStringData(
  data: Record<string, unknown>,
  key: string
): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function collectVisibleGuideTargets(): GuideTargetSnapshot[] | undefined {
  if (typeof document === "undefined") return undefined;
  const targets: GuideTargetSnapshot[] = [];
  const seen = new Set<string>();

  for (const element of Array.from(
    document.querySelectorAll<HTMLElement>(GUIDE_TARGET_SELECTOR)
  )) {
    const targetId =
      element.getAttribute("data-guide-target") ??
      element.getAttribute("data-tour-target");
    if (!targetId || seen.has(targetId)) continue;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;

    seen.add(targetId);
    targets.push({
      id: targetId,
      label:
        element.getAttribute("data-guide-label") ??
        element.getAttribute("aria-label") ??
        element.getAttribute("title") ??
        element.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ??
        targetId,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  }

  return targets.length > 0 ? targets : undefined;
}

export function collectAppUiSnapshot(): AppUiSnapshot | undefined {
  const store = getInstrumentedStore();
  const snapshot: AppUiSnapshot = {};

  const route = getWindowLocationSnapshot();
  if (route) snapshot.route = route;

  const stationMode = store.get(stationModeAtom);
  const activeStatusBarApp = store.get(activeStatusBarAppAtom);
  const statusBar = store.get(activeStatusBarStateAtom);
  snapshot.workstation = {
    stationMode,
    activeApp: activeStatusBarApp,
    browserUrl: statusBar.browserUrl,
    browserIsLoading: statusBar.browserIsLoading,
    browserIsPrivate: statusBar.browserIsPrivate,
    browserSessionCount: statusBar.browserSessionCount,
    browserCurrentSessionIndex: statusBar.browserCurrentSessionIndex,
    projectName: statusBar.projectName,
    projectSlug: statusBar.projectSlug,
  };

  const activeTab = store.get(activeWorkStationTabAtom);
  if (activeTab) {
    snapshot.workstation.activeTab = {
      id: activeTab.id,
      type: activeTab.type,
      category: activeTab.category,
      title: activeTab.title,
      filePath: getStringData(activeTab.data, "filePath"),
      url:
        getStringData(activeTab.data, "url") ??
        getStringData(activeTab.data, "currentUrl"),
      sessionId: getStringData(activeTab.data, "sessionId"),
      projectId: getStringData(activeTab.data, "projectId"),
      projectName: getStringData(activeTab.data, "projectName"),
    };
  }

  const activeSessionId = store.get(activeSessionIdAtom);
  const workstationActiveSessionId = store.get(workstationActiveSessionIdAtom);
  const sessionId = activeSessionId ?? workstationActiveSessionId;
  if (sessionId) {
    const session = store.get(sessionMapAtom).get(sessionId);
    snapshot.session = {
      activeSessionId,
      workstationActiveSessionId,
      name: session?.name,
      status: session?.status,
      category: session?.category,
      repoPath: session?.repoPath,
      model: session?.model,
      agentExecMode: session?.agentExecMode,
      cliAgentType: session?.cliAgentType,
      keySource: session?.keySource,
    };
  } else {
    snapshot.session = {
      activeSessionId,
      workstationActiveSessionId,
    };
  }

  snapshot.chatPanel = {
    visible: store.get(chatVisibleAtom),
    maximized: store.get(chatPanelMaximizedAtom),
    surface: store.get(activeChatPanelSurfaceAtom).kind,
  };

  snapshot.overlays = {
    spotlightOpen: store.get(spotlightOpenAtom),
    adeManagerEnabled: store.get(adeManagerEnabledAtom),
  };

  const guideTargets = collectVisibleGuideTargets();
  if (guideTargets) snapshot.visibleGuideTargets = guideTargets;

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

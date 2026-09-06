/**
 * SimulatorApp Registry
 *
 * Central registry for all simulator apps.
 * Maps AppType to app configuration with lazy-loaded components.
 *
 * App components live under src/modules/WorkStation/:
 * - CodeEditor/SessionReplay/ — IDE replay
 * - Browser/SessionReplay/    — Browser replay
 * - Chat/Communication/       — Messages replay (includes Canvas replay for canvas-class events)
 *
 * Event routing uses `getAppTypeForEvent()` from `constants.ts`, which queries:
 * 1. Rust built-in map (canonical tool names)
 * 2. Alias table (CLI adapters, external agents)
 */
import React, { lazy } from "react";

import { getAppTypeForEvent } from "@src/engines/SessionCore/rendering/registry/constants";
import { BACKGROUND_TASKS_APP_CONFIG } from "@src/engines/Simulator/apps/backgroundTasks/backgroundTasksConfig";
import { CANVAS_APP_CONFIG } from "@src/engines/Simulator/apps/canvas/canvasConfig";
import type {
  SimulatorAppBaseState,
  SimulatorAppConfig,
  SimulatorAppProps,
} from "@src/engines/Simulator/apps/core/types";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { BROWSER_APP_CONFIG } from "@src/modules/WorkStation/Browser/SessionReplay/config";
import { MESSAGES_APP_CONFIG } from "@src/modules/WorkStation/Chat/Communication/config";
import { DIFF_APP_CONFIG } from "@src/modules/WorkStation/Diff/SessionReplay/config";
import { STORY_APP_CONFIG } from "@src/modules/WorkStation/ProjectManager/SessionReplay/config";

// ============================================
// Event Matchers (delegate to unified getAppTypeForEvent)
// ============================================

/**
 * Returns true if the event routes to the CODE_EDITOR simulator app.
 * Uses the unified `getAppTypeForEvent` which queries Rust built-in map + alias table.
 */
function matchesCodeEditorEvent(eventFunction: string): boolean {
  return getAppTypeForEvent(eventFunction) === "CODE_EDITOR";
}

// ============================================
// Lazy-loaded Components
// ============================================

const LazySimulatorIDE = lazy(
  () => import("@src/modules/WorkStation/CodeEditor/SessionReplay")
);

const LazySimulatorMessages = lazy(
  () => import("@src/modules/WorkStation/Chat/Communication")
);

const LazySimulatorBrowser = lazy(
  () => import("@src/modules/WorkStation/Browser/SessionReplay")
);

const LazySimulatorProject = lazy(
  () => import("@src/modules/WorkStation/ProjectManager/SessionReplay")
);

const LazySimulatorDiff = lazy(
  () => import("@src/modules/WorkStation/Diff/SessionReplay")
);

const LazyBackgroundTasksApp = lazy(
  () => import("@src/engines/Simulator/apps/backgroundTasks/BackgroundTasksApp")
);

const LazyCanvasApp = lazy(
  () => import("@src/engines/Simulator/apps/canvas/CanvasApp")
);

// ============================================
// Registry Definition
// ============================================

/**
 * Registry of all simulator apps.
 * Maps AppType to configuration with component and event handling logic.
 *
 * NOTE: Order matters! Apps are checked in order, so more specific matchers
 * should come before more generic ones (e.g., PHONE before CODE).
 */
export const SIMULATOR_APP_REGISTRY: Partial<
  Record<AppType, SimulatorAppConfig<SimulatorAppBaseState>>
> = {
  [AppType.CHANNELS]: {
    ...MESSAGES_APP_CONFIG,
    component: LazySimulatorMessages as React.ComponentType<SimulatorAppProps>,
  },

  [AppType.BROWSER]: {
    ...BROWSER_APP_CONFIG,
    component: LazySimulatorBrowser as React.ComponentType<SimulatorAppProps>,
  },

  [AppType.CODE_EDITOR]: {
    id: AppType.CODE_EDITOR,
    name: "IDE",
    icon: "Code2",
    matchesEvent: matchesCodeEditorEvent,
    component:
      LazySimulatorIDE as unknown as React.ComponentType<SimulatorAppProps>,
    deriveState: (_events, _currentEventId) => ({}),
  },

  [AppType.STORY_MANAGER]: {
    ...STORY_APP_CONFIG,
    component: LazySimulatorProject as React.ComponentType<SimulatorAppProps>,
  },

  [AppType.DIFF]: {
    ...DIFF_APP_CONFIG,
    component: LazySimulatorDiff as React.ComponentType<SimulatorAppProps>,
  },

  [AppType.BACKGROUND_TASKS]: {
    ...BACKGROUND_TASKS_APP_CONFIG,
    component: LazyBackgroundTasksApp as React.ComponentType<SimulatorAppProps>,
  },

  [AppType.CANVAS]: {
    ...CANVAS_APP_CONFIG,
    component: LazyCanvasApp as React.ComponentType<SimulatorAppProps>,
  },
};

// ============================================
// Registry Access Functions
// ============================================

export function getSimulatorAppConfig<
  TState extends SimulatorAppBaseState = SimulatorAppBaseState,
>(appType: AppType): SimulatorAppConfig<TState> | null {
  const config = SIMULATOR_APP_REGISTRY[appType];
  if (!config) return null;
  return config as unknown as SimulatorAppConfig<TState>;
}

export function getAppForEvent(eventFunction: string): AppType | null {
  for (const [appType, config] of Object.entries(SIMULATOR_APP_REGISTRY)) {
    if (config && config.matchesEvent(eventFunction)) {
      return appType as AppType;
    }
  }
  return null;
}

export function hasSimulatorApp(appType: AppType): boolean {
  return appType in SIMULATOR_APP_REGISTRY;
}

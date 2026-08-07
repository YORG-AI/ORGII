import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { ROUTES } from "@src/config/routes";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";

import { getBaseUrl } from "../../core/env";
import { isTauriDesktop } from "../../platform/tauri";

const log = createLogger("WindowManager");

/**
 * Minimal tab interface for window operations.
 * Uses duck typing for optional properties like sessionId, repoPath, etc.
 */
interface TabLike {
  id: string;
  type: string;
  title: string;
  routePath?: string;
}

/**
 * Tab window data interface for passing tab information to child windows
 */
export interface TabWindowData {
  type: string;
  title: string;
  sessionId?: string;
  sessionData?: unknown;
  agentRunId?: string;
  agentData?: unknown;
  workflowId?: string;
  initialRepoPath?: string;
  repoPath?: string;
  routePath?: string;
}

// ============================================
// Window Management (Centralized via Rust)
// ============================================
//
// All windows are created through the Rust `create_app_window` command
// to ensure consistent native macOS styling (traffic lights, title bar, etc.).
//

/**
 * Open a new window via Rust command.
 *
 * Windows are created through the centralized Rust window module to ensure
 * consistent native macOS styling (traffic lights, title bar, etc.).
 *
 * @param label Unique identifier for the window
 * @param url URL to load in the window
 * @param options Window options
 * @returns Created Webview instance, or null if not in Tauri environment
 */
export const openWindow = async (
  label: string,
  url: string,
  options?: {
    width?: number;
    height?: number;
    title?: string;
    center?: boolean;
    focus?: boolean;
    resizable?: boolean;
    x?: number;
    y?: number;
  }
): Promise<WebviewWindow | null> => {
  if (!isTauriDesktop()) {
    log.warn("Cannot open window: Not in Tauri desktop environment");
    return null;
  }

  try {
    // Create window via centralized Rust command
    // This ensures consistent native macOS styling across all windows
    await invoke("create_app_window", {
      options: {
        label,
        url,
        title: options?.title ?? label,
        width: options?.width ?? 1200,
        height: options?.height ?? 800,
        center:
          options?.x === undefined &&
          options?.y === undefined &&
          (options?.center ?? true),
        focus: options?.focus ?? true,
        resizable: options?.resizable ?? true,
        x: options?.x,
        y: options?.y,
      },
    });

    // Get the created window reference for further operations
    const webview = WebviewWindow.getByLabel(label);
    return webview;
  } catch (error) {
    log.error(`Window ${label} creation failed:`, error);
    return null;
  }
};

/**
 * Close window with specified label
 *
 * @param label Unique identifier for the window
 * @returns Whether successfully closed
 */
export const closeWindow = async (label: string): Promise<boolean> => {
  if (!isTauriDesktop()) {
    return false;
  }

  try {
    const existingWindows = await WebviewWindow.getAll();
    const targetWindow = existingWindows.find((win) => win.label === label);

    if (targetWindow) {
      await targetWindow.close();
      return true;
    }

    return false;
  } catch (error) {
    log.error("Error closing window:", error);
    return false;
  }
};

/**
 * Show an existing window or create it fresh — the prewarm/reuse pattern.
 *
 * Use this instead of `openWindow` for any window with a **stable label**
 * (e.g. "mode-selection", "new-project"). The Rust side checks whether the
 * webview already exists:
 *
 * - Hot path (window prewarmed or previously opened): `show()` + `set_focus()`
 *   with optional reposition. No webview spin-up — effectively instant.
 * - Cold path (first open): identical to `openWindow`, builds the webview fresh.
 *
 * Do NOT use this for windows with dynamic labels (e.g. per-session labels
 * like `workspace-<sessionId>`) — use `openMultiWindow` for those.
 */
export const openWindowReusable = async (
  label: string,
  url: string,
  options?: {
    width?: number;
    height?: number;
    title?: string;
    center?: boolean;
    focus?: boolean;
    resizable?: boolean;
    x?: number;
    y?: number;
  }
): Promise<WebviewWindow | null> => {
  if (!isTauriDesktop()) {
    log.warn("Cannot open window: Not in Tauri desktop environment");
    return null;
  }

  try {
    await invoke("show_or_create_app_window", {
      options: {
        label,
        url,
        title: options?.title ?? label,
        width: options?.width ?? 1200,
        height: options?.height ?? 800,
        center:
          options?.x === undefined &&
          options?.y === undefined &&
          (options?.center ?? true),
        focus: options?.focus ?? true,
        resizable: options?.resizable ?? true,
        x: options?.x,
        y: options?.y,
      },
    });

    return WebviewWindow.getByLabel(label);
  } catch (error) {
    log.error(`Window ${label} show-or-create failed:`, error);
    return null;
  }
};

/**
 * Open multi-window
 *
 * @param label Unique identifier for the window
 * @param url URL path to load in the window (relative path, baseUrl will be added automatically)
 * @param options Window options
 * @returns Created WebviewWindow instance, or null if not in Tauri environment
 */
export const openMultiWindow = async (
  label: string,
  url: string,
  options?: {
    width?: number;
    height?: number;
    title?: string;
    center?: boolean;
    focus?: boolean;
    resizable?: boolean;
  }
): Promise<WebviewWindow | null> => {
  if (!isTauriDesktop()) {
    log.warn("Cannot open multi-window: Not in Tauri desktop environment");
    return null;
  }

  try {
    const baseUrl = getBaseUrl();

    // Try to get existing window by label directly (faster than getAll)
    const existingWindow = await WebviewWindow.getByLabel(label);
    if (existingWindow) {
      // If window exists, focus and return (non-blocking focus)
      existingWindow.setFocus().catch(() => {});
      return existingWindow;
    }

    const window = await openWindow(label, `${baseUrl}${url}`, {
      title: options?.title || label,
      width: options?.width || 1024,
      height: options?.height || 768,
      center: options?.center ?? true,
      focus: options?.focus ?? true,
      resizable: options?.resizable ?? true,
    });

    return window;
  } catch (error) {
    log.error(`Error opening multi-window ${label}:`, error);
    return null;
  }
};

/**
 * Open mode selection window
 *
 * @returns Created WebviewWindow instance, or null if not in Tauri environment
 */
export const openModeSelectionWindow =
  async (): Promise<WebviewWindow | null> => {
    if (!isTauriDesktop()) {
      log.warn(
        "Cannot open mode selection window: Not in Tauri desktop environment"
      );
      return null;
    }

    try {
      const baseUrl = getBaseUrl();
      return await openWindowReusable(
        "mode-selection",
        `${baseUrl}/windows/welcome`,
        {
          title: "Mode Selection",
          width: 900,
          height: 520,
          center: true,
          focus: true,
          resizable: false,
        }
      );
    } catch (error) {
      log.error("Error opening mode selection window:", error);
      return null;
    }
  };

/**
 * Open new repo window
 *
 * @returns Created WebviewWindow instance, or null if not in Tauri environment
 */
export const openNewProjectWindow = async (): Promise<WebviewWindow | null> => {
  if (!isTauriDesktop()) {
    log.warn(
      "Cannot open new project window: Not in Tauri desktop environment"
    );
    return null;
  }

  try {
    return await openMultiWindow(
      "new-project-window",
      ROUTES.app.home.start.path,
      {
        title: "New Repo",
        width: 1200,
        height: 800,
        center: true,
        focus: true,
        resizable: true,
      }
    );
  } catch (error) {
    log.error("Error opening new project window:", error);
    return null;
  }
};

/**
 * Open workspace window
 *
 * @param sessionId Session ID
 * @param projectId Project ID
 * @returns Created WebviewWindow instance, or null if not in Tauri environment
 */
export const openWorkspaceWindow = async (
  sessionId: string,
  projectId: string
): Promise<WebviewWindow | null> => {
  if (!isTauriDesktop()) {
    log.warn("Cannot open workspace window: Not in Tauri desktop environment");
    return null;
  }

  try {
    const queryParams = new URLSearchParams({
      seId: sessionId,
      projectId,
    }).toString();

    return await openMultiWindow(
      `workspace-${sessionId}`,
      `/orgii/workstation/code?${queryParams}`,
      {
        title: i18n.t("common:workspaceForm.windowTitle", "Workspace"),
        width: 1280,
        height: 800,
        center: true,
        focus: true,
        resizable: true,
      }
    );
  } catch (error) {
    log.error("Error opening workspace window:", error);
    return null;
  }
};

/**
 * Send message to main window to open workspace
 *
 * @param sessionId Session ID
 * @param projectId Project ID
 * @param buildType Build type (optional)
 * @returns Whether message was successfully sent
 */
export const emitOpenWorkspace = async (
  sessionId: string,
  projectId: string,
  buildType?: string
): Promise<boolean> => {
  if (!isTauriDesktop()) {
    log.warn("Cannot emit event: Not in Tauri desktop environment");
    return false;
  }

  try {
    // Send event message to main window
    await emit("open-workspace", {
      sessionId,
      projectId,
      buildType,
    });
    return true;
  } catch (error) {
    log.error("Error sending open workspace message:", error);
    return false;
  }
};

/**
 * Send message to main window to open workflow workspace
 *
 * @param workflowId Workflow ID
 * @param projectId Project ID
 * @returns Whether message was successfully sent
 */
export const emitOpenWorkflowWorkspace = async (
  workflowId: string,
  projectId: string
): Promise<boolean> => {
  if (!isTauriDesktop()) {
    log.warn("Cannot emit event: Not in Tauri desktop environment");
    return false;
  }

  try {
    // Send event message to main window
    await emit("open-workflow-workspace", {
      workflowId,
      projectId,
    });
    return true;
  } catch (error) {
    log.error("Error sending open workflow workspace message:", error);
    return false;
  }
};

/**
 * Toggle main window show/hide state
 */
export const toggleMainWindow = async (): Promise<void> => {
  if (!isTauriDesktop()) {
    log.warn("Cannot toggle window: Not in Tauri desktop environment");
    return;
  }

  try {
    // Get all windows
    const allWindows = await WebviewWindow.getAll();

    // Find main window (usually the first window or window named 'main')
    let mainWindow = allWindows.find((win) => win.label === "main");

    // If no window named 'main' is found, use the first window
    if (!mainWindow && allWindows.length > 0) {
      mainWindow = allWindows[0];
    }

    if (!mainWindow) {
      log.warn("Main window not found");
      return;
    }

    // Check if window is visible
    const isVisible = await mainWindow.isVisible();

    if (isVisible) {
      // If window is visible, hide it
      await mainWindow.hide();
    } else {
      // If window is hidden, show and focus it
      await mainWindow.show();
      await mainWindow.setFocus();
    }
  } catch (error) {
    log.error("Failed to toggle main window state:", error);
  }
};

/**
 * Open a tab in a new window
 *
 * @param tab The tab to open in a new window
 * @param options Optional position and size options for the new window
 * @returns The created WebviewWindow instance, or null if not in Tauri environment
 */
export const openTabInNewWindow = async (
  tab: TabLike,
  options?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }
): Promise<WebviewWindow | null> => {
  if (!isTauriDesktop()) {
    log.warn("Cannot open tab in new window: Not in Tauri desktop environment");
    return null;
  }

  try {
    // Create tab window data
    const tabData: TabWindowData = {
      type: tab.type,
      title: tab.title,
      sessionId:
        "sessionId" in tab ? (tab.sessionId as string | undefined) : undefined,
      sessionData: "sessionData" in tab ? tab.sessionData : undefined,
      agentRunId:
        "agentRunId" in tab
          ? (tab.agentRunId as string | undefined)
          : undefined,
      agentData: "agentData" in tab ? tab.agentData : undefined,
      workflowId: undefined,
      initialRepoPath:
        "initialRepoPath" in tab
          ? (tab.initialRepoPath as string | undefined)
          : undefined,
      repoPath:
        "repoPath" in tab ? (tab.repoPath as string | undefined) : undefined,
      routePath: tab.routePath,
    };

    // Encode the tab data as a URL parameter
    const encodedData = encodeURIComponent(JSON.stringify(tabData));
    const targetUrl = `/windows/tab?data=${encodedData}`;

    const baseUrl = getBaseUrl();
    const windowLabel = `tab-${tab.id}-${Date.now()}`;

    return await openWindow(windowLabel, `${baseUrl}${targetUrl}`, {
      title: tab.title,
      width: options?.width ?? 1200,
      height: options?.height ?? 800,
      center: options?.x === undefined && options?.y === undefined,
      focus: true,
      resizable: true,
      x: options?.x,
      y: options?.y,
    });
  } catch (error) {
    log.error("Error opening tab in new window:", error);
    return null;
  }
};

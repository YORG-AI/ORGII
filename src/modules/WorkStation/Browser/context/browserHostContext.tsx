/**
 * Browser host context — Phase 2.2 of the WorkStation unified-tab migration.
 *
 * Publishes the Browser host's rendering surface ABOVE the tab dispatcher so
 * that `UnifiedTabContent` renderers for browser tab types (`browser-session`,
 * `devtools`) can consume it directly, instead of receiving it as props
 * threaded through the bespoke `BrowserLayout` render tree. This is the "host
 * context hoist" the staged renderers (`TabContent/renderers/browserSession.tsx`,
 * `TabContent/renderers/devtools.tsx`) wait on before they can drop their
 * `HostCoupledPlaceholder` stubs.
 *
 * Mirrors `ProjectHostProvider` (Phase 2.1). Two payloads:
 *   - The shared webview workspace surface (`browserState` + activation flags +
 *     inspect / native-devtools handlers) so `browser-session` can mount the
 *     rect-publisher (`SharedBrowserWorkspace`) and position the already-hoisted
 *     global webview over its pane.
 *   - The DevTools polling stack (`useBrowserConsole` / `useBrowserNetworkLogs`
 *     / `useWebviewInspector` entries + counts + selected element) plus panel
 *     size / position handlers, so `devtools` can render the real
 *     `SharedBrowserDevToolsPanel` without re-instantiating the polling hooks.
 *
 * The webview engine (`SharedBrowserApp`) and session store
 * (`BrowserProvider`) are already mounted globally above the workstation
 * (`src/modules/index.tsx`); this context only hoists the browser-host-owned
 * polling + panel state, which lives inside `BrowserLayout` today.
 */
import { type ReactNode, createContext, useContext } from "react";

import type { UseBrowserStateReturn } from "@src/engines/BrowserCore/hooks/useBrowserState";
import type { UseBrowserSessionsReturn } from "@src/hooks/workStation/browser/useBrowserSessions";
import type { SecondaryPanelPosition } from "@src/store/ui/workStationAtom";

export interface BrowserHostContextValue {
  /** Repository path for source navigation + token scanning. */
  repoPath: string;

  // ============================================
  // Shared webview workspace (browser-session renderer)
  // ============================================

  /** Global browser session store (from `useBrowserContextAdapter`). */
  browserState: UseBrowserStateReturn;
  /**
   * Host-level activation for the shared webview: browser mode is active, the
   * viewport should show, and no automation run is overlaying it. A renderer
   * ANDs this with its own `isActive`/session-match before publishing a rect.
   */
  isWorkspaceActive: boolean;
  /** Whether webviews should be hidden (mode inactive / viewport not shown). */
  hideWebviews: boolean;
  /** Bottom inset (px) reserved below the webview frame. */
  webviewBottomInsetPx: number;
  isInspectMode: boolean;
  onToggleInspectMode: () => void;
  onOpenNativeDevTools: () => void;
  /** Toggle the DevTools pane from the webview toolbar. */
  onToggleDevToolsPane: () => void;
  devToolsPaneCollapsed: boolean;
  /** Quick actions shown in the empty-workspace placeholder. */

  // ============================================
  // DevTools panel (devtools renderer)
  // ============================================

  devToolsCollapsed: boolean;
  onToggleDevToolsCollapse: () => void;
  devToolsPanelWidth: number;
  onDevToolsPanelWidthChange: (width: number) => void;
  devToolsPanelHeight: number;
  onDevToolsPanelHeightChange: (height: number) => void;
  devToolsPosition: SecondaryPanelPosition;
  onToggleDevToolsPosition: () => void;
  consoleEntries: UseBrowserSessionsReturn["entries"];
  onClearConsoleEntries: () => void;
  networkEntries: UseBrowserSessionsReturn["networkEntries"];
  onClearNetworkEntries: () => void;
  errorCount: number;
  warningCount: number;
  selectedElement: UseBrowserSessionsReturn["selectedElement"];
  /** Webview label of the active session (for the DOM tree). */
  webviewLabel: string;
  /** Current page URL (triggers DOM refresh on navigation). */
  currentUrl: string;
}

const BrowserHostContext = createContext<BrowserHostContextValue | null>(null);

export function BrowserHostProvider({
  value,
  children,
}: {
  value: BrowserHostContextValue;
  children: ReactNode;
}) {
  return (
    <BrowserHostContext.Provider value={value}>
      {children}
    </BrowserHostContext.Provider>
  );
}

/**
 * Read the Browser host context. Throws if used outside a
 * `BrowserHostProvider` — this guards against mounting a browser renderer
 * through the unified dispatcher before the host context has been hoisted
 * above it (which would otherwise silently render a degraded surface, e.g. a
 * DevTools tab with no polling data or a webview with no rect publisher).
 */
export function useBrowserHostContext(): BrowserHostContextValue {
  const ctx = useContext(BrowserHostContext);
  if (ctx === null) {
    throw new Error(
      "useBrowserHostContext must be used within a BrowserHostProvider"
    );
  }
  return ctx;
}

/**
 * Renderer wrapper for `devtools` tabs.
 *
 * DevTools is rendered today inside the Browser host's
 * `SharedBrowserDevToolsPanel` (right/bottom secondary panel), which depends on
 * the polling stack instantiated inside `useBrowserSessions`
 * (`useBrowserConsole` / `useBrowserNetworkLogs` / `useWebviewInspector`).
 * Phase 2.2 hoists that state through `BrowserHostProvider`, so this tab can
 * render the real inspector by pulling entries / counts / selected element /
 * webview label + panel handlers from `useBrowserHostContext`.
 *
 * NOTE (Phase 2.2): `UnifiedTabContent` is not yet mounted for browser tabs by
 * `BrowserLayout`, so this renderer is staged/inert until the live mount lands.
 */
import React, { memo } from "react";

import { useBrowserHostContext } from "@src/modules/WorkStation/Browser/context/browserHostContext";
import { SharedBrowserDevToolsPanel } from "@src/modules/WorkStation/Browser/shared";

import type { UnifiedTabContentProps } from "../types";

const DevtoolsTabRenderer: React.FC<UnifiedTabContentProps> = memo(() => {
  const {
    repoPath,
    devToolsPanelWidth,
    onDevToolsPanelWidthChange,
    devToolsPosition,
    onToggleDevToolsPosition,
    onToggleDevToolsCollapse,
    consoleEntries,
    onClearConsoleEntries,
    networkEntries,
    onClearNetworkEntries,
    errorCount,
    warningCount,
    selectedElement,
    webviewLabel,
    currentUrl,
  } = useBrowserHostContext();

  return (
    <SharedBrowserDevToolsPanel
      // A DevTools *tab* always renders the full inspector — the collapsed
      // rail is a secondary-panel affordance and is meaningless as a tab body.
      isCollapsed={false}
      onToggleCollapse={onToggleDevToolsCollapse}
      width={devToolsPanelWidth}
      onWidthChange={onDevToolsPanelWidthChange}
      entries={consoleEntries}
      onClearEntries={onClearConsoleEntries}
      networkEntries={networkEntries}
      onClearNetworkEntries={onClearNetworkEntries}
      errorCount={errorCount}
      warningCount={warningCount}
      selectedElement={selectedElement}
      webviewLabel={webviewLabel}
      repoPath={repoPath}
      currentUrl={currentUrl}
      position={devToolsPosition}
      onTogglePosition={onToggleDevToolsPosition}
    />
  );
});

DevtoolsTabRenderer.displayName = "DevtoolsTabRenderer";

export default DevtoolsTabRenderer;

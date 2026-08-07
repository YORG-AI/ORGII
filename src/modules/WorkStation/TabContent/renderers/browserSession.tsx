/**
 * Renderer wrapper for `browser-session` tabs.
 *
 * The webview engine (`SharedBrowserApp`) and session store
 * (`BrowserProvider`) are mounted globally above the workstation
 * (`src/modules/index.tsx`); a single native webview per host is positioned by
 * a rect published from whichever pane owns it. This renderer mounts the
 * rect-publisher (`SharedBrowserWorkspace` → `SharedBrowserHostSlot`) for the
 * MY_STATION host, pulling `browserState` + activation flags + inspect /
 * native-devtools handlers from the hoisted Browser host context
 * (`useBrowserHostContext`) — mirroring how `BrowserLayout` mounts the
 * workspace today. No webview is re-created on tab switch: the pane only
 * re-publishes its rect.
 *
 * NOTE (Phase 2.2): `UnifiedTabContent` is not yet mounted for browser tabs by
 * `BrowserLayout`, so this renderer is staged/inert until the live mount lands.
 * When it does, only the active browser-session pane must be `active` — two
 * panes publishing to the same host id would fight over the single webview
 * rect.
 */
import React, { memo } from "react";

import { useBrowserHostContext } from "@src/modules/WorkStation/Browser/context/browserHostContext";
import {
  SHARED_BROWSER_HOST,
  SHARED_BROWSER_HOST_SCOPE,
  SharedBrowserWorkspace,
} from "@src/modules/WorkStation/Browser/shared";

import type { UnifiedTabContentProps } from "../types";

const BrowserSessionTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ isActive }) => {
    const {
      browserState,
      isWorkspaceActive,
      hideWebviews,
      webviewBottomInsetPx,
      isInspectMode,
      onToggleInspectMode,
      onOpenNativeDevTools,
      onToggleDevToolsPane,
      devToolsPaneCollapsed,
    } = useBrowserHostContext();

    return (
      <SharedBrowserWorkspace
        hostId={SHARED_BROWSER_HOST.MY_STATION}
        scope={SHARED_BROWSER_HOST_SCOPE.MY_STATION}
        active={isActive && isWorkspaceActive}
        browserState={browserState}
        onOpenNativeDevTools={onOpenNativeDevTools}
        onToggleDevToolsPane={onToggleDevToolsPane}
        devToolsPaneCollapsed={devToolsPaneCollapsed}
        hideWebviews={hideWebviews || !isActive}
        webviewBottomInsetPx={webviewBottomInsetPx}
        isInspectMode={isInspectMode}
        onToggleInspectMode={onToggleInspectMode}
      />
    );
  }
);

BrowserSessionTabRenderer.displayName = "BrowserSessionTabRenderer";

export default BrowserSessionTabRenderer;

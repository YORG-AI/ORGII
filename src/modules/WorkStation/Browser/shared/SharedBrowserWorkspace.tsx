import type { FC } from "react";

import type { UseBrowserStateReturn } from "@src/engines/BrowserCore/hooks/useBrowserState";
import { BROWSER_WEBVIEW_FRAME_ANCHOR_SELECTOR } from "@src/engines/BrowserCore/nativeFrameAnchor";
import type { WorkstationTabHeaderHost } from "@src/hooks/tabHost/useWorkstationTabHeader";
import {
  NoTabsPlaceholder,
  type QuickAction,
} from "@src/modules/WorkStation/shared";

import WebViewport from "../Panels/BrowserMainPane/content/WebViewportContent";
import { SharedBrowserHostSlot } from "./SharedBrowserHostSlot";
import type {
  SharedBrowserHostId,
  SharedBrowserHostScope,
} from "./sharedBrowserHostAtoms";

const ABOUT_BLANK_URL = "about:blank";

function isBlankBrowserUrl(url?: string): boolean {
  const normalizedUrl = url?.trim().toLowerCase();
  return !normalizedUrl || normalizedUrl.startsWith(ABOUT_BLANK_URL);
}

export interface SharedBrowserWorkspaceProps {
  hostId: SharedBrowserHostId;
  scope?: SharedBrowserHostScope;
  active: boolean;
  browserState: UseBrowserStateReturn;
  onOpenNativeDevTools?: () => void;
  onToggleDevToolsPane?: () => void;
  devToolsPaneCollapsed?: boolean;
  publishUrlBarToHost?: WorkstationTabHeaderHost;
  respectModalBlocking?: boolean;
  hideTabBar?: boolean;
  hideWebviews?: boolean;
  inlineUrlBar?: boolean;
  isInspectMode?: boolean;
  onToggleInspectMode?: () => void;
  placeholderCaption?: string;
  placeholderActions?: QuickAction[];
  className?: string;
  webviewBottomInsetPx?: number;
}

export const SharedBrowserWorkspace: FC<SharedBrowserWorkspaceProps> = ({
  hostId,
  scope,
  active,
  browserState,
  onOpenNativeDevTools,
  onToggleDevToolsPane,
  devToolsPaneCollapsed = false,
  publishUrlBarToHost,
  respectModalBlocking = false,
  hideTabBar = true,
  hideWebviews = false,
  inlineUrlBar = false,
  isInspectMode = false,
  onToggleInspectMode,
  placeholderCaption,
  placeholderActions,
  className = "h-full w-full",
  webviewBottomInsetPx = 0,
}) => {
  const hasBrowserSessions = browserState.sessions.length > 0;
  const activeSession = browserState.sessions.find(
    (session) => session.id === browserState.activeSessionId
  );
  const shouldActivateNativeHost =
    active &&
    hasBrowserSessions &&
    !isBlankBrowserUrl(activeSession?.url) &&
    !hideWebviews;

  return (
    <div className={className}>
      {!hasBrowserSessions ? (
        <NoTabsPlaceholder
          icon="browser"
          caption={placeholderCaption}
          actions={placeholderActions}
        />
      ) : (
        <SharedBrowserHostSlot
          hostId={hostId}
          scope={scope}
          active={shouldActivateNativeHost}
          bottomInsetPx={webviewBottomInsetPx}
          measureSelector={BROWSER_WEBVIEW_FRAME_ANCHOR_SELECTOR}
        >
          <WebViewport
            browserState={browserState}
            onOpenNativeDevTools={onOpenNativeDevTools}
            onToggleDevToolsPane={onToggleDevToolsPane}
            devToolsPaneCollapsed={devToolsPaneCollapsed}
            hideTabBar={hideTabBar}
            hideWebviews={!active || hideWebviews}
            publishUrlBarToHost={publishUrlBarToHost}
            respectModalBlocking={respectModalBlocking}
            inlineUrlBar={inlineUrlBar}
            isInspectMode={isInspectMode}
            onToggleInspectMode={onToggleInspectMode}
            manageWebviews={false}
          />
        </SharedBrowserHostSlot>
      )}
    </div>
  );
};

SharedBrowserWorkspace.displayName = "SharedBrowserWorkspace";

export default SharedBrowserWorkspace;

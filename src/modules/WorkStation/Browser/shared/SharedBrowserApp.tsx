import { useAtomValue } from "jotai";
import React, { Suspense, memo, useLayoutEffect, useMemo } from "react";

import { useBrowserContextAdapter } from "@src/engines/BrowserCore/hooks/useBrowserContextAdapter";
import { dispatchWebviewLayoutChanged } from "@src/hooks/platform/useInlineWebview/webviewLayoutEvents";
import { webviewOverlayBlockedAtom } from "@src/store/ui/overlayAtom";

import { activeSharedBrowserHostAtom } from "./sharedBrowserHostAtoms";

const BrowserCore = React.lazy(() => import("@src/engines/BrowserCore"));

const OFFSCREEN_STYLE: React.CSSProperties = {
  position: "fixed",
  left: -10000,
  top: -10000,
  width: 1,
  height: 1,
  pointerEvents: "none",
  overflow: "hidden",
};

export const SharedBrowserApp: React.FC = memo(() => {
  const browserState = useBrowserContextAdapter();
  const activeHost = useAtomValue(activeSharedBrowserHostAtom);
  const isWebviewBlocked = useAtomValue(webviewOverlayBlockedAtom);

  const activeRect = activeHost?.rect ?? null;
  const hasBrowserSessions = browserState.sessions.length > 0;
  const hostStyle = useMemo<React.CSSProperties>(() => {
    if (!activeRect) return OFFSCREEN_STYLE;
    return {
      position: "fixed",
      left: activeRect.x,
      top: activeRect.y,
      width: activeRect.width,
      height: activeRect.height,
      pointerEvents: "none",
      overflow: "hidden",
      zIndex: 0,
    };
  }, [activeRect]);

  useLayoutEffect(() => {
    dispatchWebviewLayoutChanged();
  }, [activeRect]);

  return (
    <div aria-hidden="true" style={hostStyle}>
      {hasBrowserSessions && (
        <Suspense fallback={null}>
          <BrowserCore
            browserState={browserState}
            respectModalBlocking={false}
            className="p-0!"
            hidden={!activeRect || isWebviewBlocked}
            manageWebviews
            bypassStationModeBlocking
          />
        </Suspense>
      )}
    </div>
  );
});

SharedBrowserApp.displayName = "SharedBrowserApp";

export default SharedBrowserApp;

/**
 * MainAppShell
 *
 * Persistent flat, edge-to-edge shell for the single Modern layout.
 */
import { useAtomValue } from "jotai";
import KeepAliveRouteOutlet from "keepalive-for-react-router";
import React, { Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { deriveRouteCacheKey } from "@src/config/mainAppPaths";
import MainAppPageHeader from "@src/modules/MainApp/shared/MainAppPageHeader";
import ScrollRestorationWrapper from "@src/modules/shared/components/ScrollRestorationWrapper";
import { getPagePanelBackgroundStyle } from "@src/modules/shared/layouts/viewContainerTokens";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";

// ============================================
// MainAppShell Component
// ============================================

/**
 * MainAppShell - wraps all child routes with persistent container
 * Pages render INSIDE this container, so they shouldn't include p-2 or bg-bg-2
 */
const MainAppShell: React.FC = () => {
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);

  // Cache key is collapsed to the "route instance" — see
  // `deriveRouteCacheKey` for the rationale. Intra-page navigation
  // (sidebar clicks, wizard query params, drill-downs) keeps the
  // same key so the KeepAlive outlet reuses the mounted tree instead
  // of remounting (which would restart every data-fetch hook and
  // flash the Suspense fallback because the lazy chunk's entry
  // component is re-resolved as a *new* instance).
  const currentKey = deriveRouteCacheKey(location.pathname);

  // Hide the *outgoing* cached node synchronously, before the
  // browser paints the intermediate frame. `keepalive-for-react`
  // removes the old node and appends the new one from a post-paint
  // `useEffect`, so between the commit and its effect the DOM still
  // renders the previous route — that's the "shadow" of the last
  // route's pane that leaks through on sidebar clicks. Forcing
  // `display: none` on any still-active-but-stale cache node here
  // eliminates that frame. The style is cleared in a `useEffect`
  // below (which runs *after* the library's effect has swapped the
  // DOM), so revisits to a cached route aren't left invisible.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const activeNodes = container.querySelectorAll<HTMLElement>(
      "[data-cache-key].active"
    );
    activeNodes.forEach((node) => {
      if (node.getAttribute("data-cache-key") !== currentKey) {
        node.style.display = "none";
      }
    });
  }, [currentKey]);

  // After paint: clear any inline `display: none` we applied above on
  // the node that now matches `currentKey` (this catches revisits to
  // a cached route, where the same DOM node was re-appended and still
  // carries a stale inline style from the previous hide pass).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const match = container.querySelector<HTMLElement>(
      `[data-cache-key="${CSS.escape(currentKey)}"]`
    );
    if (match && match.style.display === "none") {
      match.style.display = "";
    }
  }, [currentKey]);

  const pageOpacityStyle = getPagePanelBackgroundStyle(
    backgroundConfig.pageOpacity
  );
  const innerPanelStyle = {
    ...pageOpacityStyle,
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties;

  const isSettingsRoute = location.pathname.startsWith("/orgii/app/settings");

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        style={innerPanelStyle}
        ref={containerRef}
      >
        {!isSettingsRoute && <MainAppPageHeader style={pageOpacityStyle} />}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={null}>
            <KeepAliveRouteOutlet
              max={12}
              wrapperComponent={ScrollRestorationWrapper}
              activeCacheKey={currentKey}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
};

export default MainAppShell;

// ============================================
// ShellFallback Component
// ============================================

/**
 * ShellFallback - standalone fallback for routes not using MainAppShell
 * Shows the same container structure during loading (always default variant)
 */
export const ShellFallback: React.FC = () => {
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const pageOpacityStyle = getPagePanelBackgroundStyle(
    backgroundConfig.pageOpacity
  );
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div
        className="min-h-0 flex-1 overflow-hidden"
        style={
          {
            ...pageOpacityStyle,
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties
        }
      />
    </div>
  );
};

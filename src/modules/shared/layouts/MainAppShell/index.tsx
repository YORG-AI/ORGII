/**
 * MainAppShell
 *
 * Flat, edge-to-edge shell for standalone application pages.
 */
import { useAtomValue } from "jotai";
import React, { Suspense } from "react";
import { Outlet } from "react-router-dom";

import MainAppPageHeader from "@src/modules/MainApp/shared/MainAppPageHeader";
import { getPagePanelBackgroundStyle } from "@src/modules/shared/layouts/viewContainerTokens";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";

// ============================================
// MainAppShell Component
// ============================================

/**
 * MainAppShell - wraps standalone child routes with a page container.
 * Pages render INSIDE this container, so they shouldn't include p-2 or bg-bg-2
 */
const MainAppShell: React.FC = () => {
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);

  const pageOpacityStyle = getPagePanelBackgroundStyle(
    backgroundConfig.pageOpacity
  );
  const innerPanelStyle = {
    ...pageOpacityStyle,
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        style={innerPanelStyle}
      >
        <MainAppPageHeader style={pageOpacityStyle} />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={null}>
            <Outlet />
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

/**
 * ViewModeSync Component
 *
 * Responsibilities:
 * 1. Route changes → Updates viewMode atom (ONE-WAY SYNC)
 *
 * NOTE: ViewMode → Route navigation is now handled directly by useAppNavigation.
 * See: src/hooks/navigation/useAppNavigation.ts
 *
 * Usage:
 * Place once in the router (in RootLayout in router/index.tsx)
 */
import { useAtom } from "jotai";
import { type FC, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import {
  getRouteConfig,
  getViewModeForRoute,
} from "@src/config/routeViewModeConfig";
import { ROUTES } from "@src/config/routes";
import {
  ViewModeType,
  settingsReturnRouteAtom,
  viewModeAtom,
  viewModePreviousRouteAtom,
  viewModeSwitchingAtom,
} from "@src/store/ui/viewModeAtom";

/**
 * ViewModeSync Component
 */
export const ViewModeSync: FC = () => {
  const location = useLocation();
  const [viewMode, setViewMode] = useAtom(viewModeAtom);
  const [_previousRoute, setPreviousRoute] = useAtom(viewModePreviousRouteAtom);
  const [_settingsReturnRoute, setSettingsReturnRoute] = useAtom(
    settingsReturnRouteAtom
  );
  const [isSwitching, _setIsSwitching] = useAtom(viewModeSwitchingAtom);

  // Track previous values for Route → ViewMode sync
  const prevPathnameRef = useRef<string>("");
  const prevRouteRef = useRef<string>("");
  const prevViewModeRef = useRef<ViewModeType>(viewMode);

  // ============================================
  // Route → ViewMode Sync (ONE-WAY)
  // ============================================

  useEffect(() => {
    const pathname = location.pathname;
    const route = `${location.pathname}${location.search}`;

    // Skip if in the middle of a view mode switch (programmatic navigation, etc.)
    if (isSwitching) {
      return;
    }

    const routeViewMode = getViewModeForRoute(pathname);
    const routeChanged = prevRouteRef.current !== route;
    if (!routeChanged) return;

    const previousPathname = prevPathnameRef.current;
    const previousRoute = prevRouteRef.current;
    const settingsPath = ROUTES.app.settings.path;
    const isSettingsRoute = pathname.startsWith(settingsPath);
    const isEnteringSettings =
      isSettingsRoute &&
      previousPathname &&
      !previousPathname.startsWith(settingsPath);
    if (isEnteringSettings) {
      setSettingsReturnRoute(previousRoute || previousPathname);
    } else if (isSettingsRoute && !previousPathname) {
      setSettingsReturnRoute("");
    }

    // Save previous route if leaving mainApp (legacy support)
    if (routeChanged && prevPathnameRef.current) {
      const prevConfig = getRouteConfig(prevPathnameRef.current);
      if (
        prevConfig?.saveToPreviousRoute !== false &&
        routeViewMode !== prevViewModeRef.current &&
        prevViewModeRef.current === "mainApp"
      ) {
        setPreviousRoute(prevPathnameRef.current);
      }
    }

    // Update viewMode
    if (viewMode !== routeViewMode) {
      setViewMode(routeViewMode);
    }

    prevPathnameRef.current = pathname;
    prevRouteRef.current = route;
    prevViewModeRef.current = routeViewMode;
  }, [
    location.pathname,
    location.search,
    viewMode,
    setViewMode,
    setPreviousRoute,
    setSettingsReturnRoute,
    isSwitching,
  ]);

  return null;
};

export default ViewModeSync;

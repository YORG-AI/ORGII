import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import {
  type SettingsSectionSegment,
  buildSettingsPath,
} from "@src/config/mainAppPaths";

import { resolveSettingsRoute } from "../settingsRouteModel";

export function useSettingsRouteState() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = useMemo(
    () => resolveSettingsRoute(location.pathname),
    [location.pathname]
  );

  useEffect(() => {
    if (route.canonicalPath) {
      navigate(route.canonicalPath, { replace: true });
    }
  }, [navigate, route.canonicalPath]);

  const handleSectionTabChange = useCallback(
    (tab: string) => {
      navigate(
        buildSettingsPath({
          section: route.activeSection as SettingsSectionSegment,
          tab,
        })
      );
    },
    [navigate, route.activeSection]
  );

  return { ...route, handleSectionTabChange };
}

/**
 * FloatingSidebar
 *
 * Renders the floating sidebar that appears when hovering over the collapsed sidebar area.
 * Uses ForceVisibleSidebarContext to ensure sidebars render even when collapsed.
 */
import { WorkstationSidebarConnector } from "@/src/scaffold/NavigationSidebar/connectors";
import { ForceVisibleSidebarProvider } from "@/src/scaffold/NavigationSidebar/contexts/ForceVisibleContext";
import SettingsSidebar from "@/src/scaffold/NavigationSidebar/variants/SettingsSidebar";
import React, { useMemo } from "react";

import { useRouteLayoutType } from "../hooks";

export const FloatingSidebar: React.FC = React.memo(() => {
  const layoutType = useRouteLayoutType();

  const sidebarContent = useMemo(() => {
    switch (layoutType) {
      case "session":
        return <WorkstationSidebarConnector />;
      case "settings":
        return <SettingsSidebar />;
      case "standard":
      default:
        return null;
    }
  }, [layoutType]);

  if (!sidebarContent) {
    return null;
  }

  return (
    <ForceVisibleSidebarProvider>{sidebarContent}</ForceVisibleSidebarProvider>
  );
});

FloatingSidebar.displayName = "FloatingSidebar";

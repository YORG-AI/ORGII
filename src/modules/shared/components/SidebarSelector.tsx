/**
 * Sidebar Selector Component
 *
 * All sidebars stay mounted to prevent DOM destroy/recreate on route
 * switches (which causes a layout bounce). The inactive sidebar is hidden
 * with `display: none`; the active one renders inside a thin flex-item
 * wrapper (flexShrink: 0) so SidebarBase keeps its resize handle in the
 * correct stacking context.
 *
 * NOTE: `display: contents` was removed because it broke the resize handle
 * in WebKit — the handle's absolutely-positioned hit area lost reliable
 * pointer events when its nearest box-generating ancestor was skipped.
 */
import { HomeSidebar } from "@/src/scaffold/NavigationSidebar";
import { WorkstationSidebarConnector } from "@/src/scaffold/NavigationSidebar/connectors";
import React from "react";

import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/generalLayoutTourConfig";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";

import { useRouteLayoutType } from "../hooks";

const STYLE_ACTIVE: React.CSSProperties = { flexShrink: 0 };
const STYLE_HIDDEN: React.CSSProperties = { display: "none" };

export const SidebarSelector: React.FC = React.memo(() => {
  const layoutType = useRouteLayoutType();

  const isHome = layoutType === "home";
  const isSession = layoutType === "session";

  if (!isHome && !isSession) return null;

  return (
    <>
      <div
        style={isHome ? STYLE_ACTIVE : STYLE_HIDDEN}
        data-guide-target={isHome ? GUIDE_TARGETS.SIDEBAR : undefined}
      >
        <HomeSidebar />
      </div>
      <div
        style={isSession ? STYLE_ACTIVE : STYLE_HIDDEN}
        data-guide-target={isSession ? GUIDE_TARGETS.SIDEBAR : undefined}
        data-tour-target={
          isSession ? GENERAL_LAYOUT_TOUR_TARGETS.sessionSidebar : undefined
        }
      >
        <WorkstationSidebarConnector />
      </div>
    </>
  );
});

SidebarSelector.displayName = "SidebarSelector";

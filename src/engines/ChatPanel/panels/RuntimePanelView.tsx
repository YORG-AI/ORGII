import React from "react";

import RuntimeDataSourcePanel from "@src/modules/shared/dataSource";

import { StartPageQuotaGrid } from "../StartPageQuotaGrid";
import WorkspaceDashboardPanelView from "./WorkspaceDashboardPanelView";

/** First-class Runtime surface: usage, quota, local sources, hooks, and assets. */
export default function RuntimePanelView(): React.ReactElement {
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <RuntimeDataSourcePanel
        quotaContent={<StartPageQuotaGrid />}
        assetsContent={<WorkspaceDashboardPanelView />}
      />
    </div>
  );
}

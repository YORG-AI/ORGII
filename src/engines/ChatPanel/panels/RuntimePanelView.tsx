import React, { useMemo, useState } from "react";

import { usePublishChatPanelHeader } from "@src/engines/ChatPanel/header";
import DataSourcePanel, {
  type DataSourcePanelView,
  DataSourcePanelViewTabs,
} from "@src/modules/shared/dataSource";

import { StartPageQuotaGrid } from "../StartPageQuotaGrid";
import WorkspaceDashboardPanelView from "./WorkspaceDashboardPanelView";

/** First-class Runtime surface: usage, quota, local sources, hooks, and assets. */
export default function RuntimePanelView(): React.ReactElement {
  const [panelView, setPanelView] = useState<DataSourcePanelView>("usage");
  const headerContent = useMemo(
    () => (
      <div className="flex min-w-0 flex-1 justify-center overflow-x-auto scrollbar-hide">
        <DataSourcePanelViewTabs
          activeView={panelView}
          showQuota
          showAssets
          size="small"
          onChange={setPanelView}
        />
      </div>
    ),
    [panelView]
  );
  const headerContribution = useMemo(
    () => ({ content: headerContent }),
    [headerContent]
  );
  usePublishChatPanelHeader({ content: headerContribution });

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <DataSourcePanel
        activePanelView={panelView}
        onPanelViewChange={setPanelView}
        hideHeader
        quotaContent={<StartPageQuotaGrid />}
        assetsContent={<WorkspaceDashboardPanelView />}
      />
    </div>
  );
}

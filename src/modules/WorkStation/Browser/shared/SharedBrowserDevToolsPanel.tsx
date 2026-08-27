import React, { Suspense, lazy, memo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS } from "@src/modules/WorkStation/shared/tokens";

import type { WebInspectorProps } from "../Panels/BrowserSecondaryPanel/components/WebInspector";

const WebInspector = lazy(
  () => import("../Panels/BrowserSecondaryPanel/components/WebInspector")
);

export type SharedBrowserDevToolsPanelProps = WebInspectorProps;

export const SharedBrowserDevToolsPanel: React.FC<SharedBrowserDevToolsPanelProps> =
  memo((props) => (
    <Suspense
      fallback={
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
          className={WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS}
        />
      }
    >
      <WebInspector {...props} />
    </Suspense>
  ));

SharedBrowserDevToolsPanel.displayName = "SharedBrowserDevToolsPanel";

export default SharedBrowserDevToolsPanel;

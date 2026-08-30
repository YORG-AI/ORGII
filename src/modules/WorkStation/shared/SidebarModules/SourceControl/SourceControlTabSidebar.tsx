/** Lazy registry entry for the Source Control tab sidebar. */
import React, { Suspense } from "react";

import { Placeholder } from "@src/components/Placeholder";

import { type TabSidebarComponent, registerTabSidebar } from "../registry";

const SourceControlTabSidebarContent = React.lazy(
  () => import("./SourceControlTabSidebarContent")
);

const SourceControlTabSidebar: TabSidebarComponent = (props) => (
  <Suspense
    fallback={
      <Placeholder variant="loading" placement="sidebar" fillParentHeight />
    }
  >
    <SourceControlTabSidebarContent {...props} />
  </Suspense>
);

SourceControlTabSidebar.displayName = "SourceControlTabSidebar";

registerTabSidebar("source-control", {
  component: SourceControlTabSidebar,
  keepAlive: false,
});

export { SourceControlTabSidebar };

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

// Kept warm alongside the Review main pane per `tabRetention.ts`; the
// sidebar slot reads the policy, so nothing is declared here.
registerTabSidebar("source-control", SourceControlTabSidebar);

export { SourceControlTabSidebar };

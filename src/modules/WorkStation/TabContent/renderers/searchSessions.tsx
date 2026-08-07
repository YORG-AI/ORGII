/**
 * Renderer wrapper for `search-sessions` tabs.
 *
 * Hosts the entire Kanban / Work Management pane — the same `WorkManagementPage`
 * the chat pane mounts in its management tab — inside a WorkStation tab, so the
 * pane can be opened either in the chat pane or here. It reads only global
 * atoms, so the two surfaces mirror each other.
 *
 * `embedded` makes the pane suppress its own 40px header and republish its
 * controls (view-switch + filters) into the shared WorkStation tab-header bar,
 * which also disables the primary-sidebar toggle for this sidebar-less tab.
 */
import React, { memo } from "react";

import WorkManagementPage from "@src/modules/MainApp/WorkManagement";

import type { UnifiedTabContentProps } from "../types";

const SearchSessionsTabRenderer: React.FC<UnifiedTabContentProps> = memo(() => (
  <WorkManagementPage embedded />
));

SearchSessionsTabRenderer.displayName = "SearchSessionsTabRenderer";

export default SearchSessionsTabRenderer;

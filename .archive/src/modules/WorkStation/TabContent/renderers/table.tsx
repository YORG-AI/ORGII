/**
 * Renderer wrapper for `table` (database) tabs.
 *
 * `DatabaseMainPane` requires `connectionId`, `tableName`, `tables`
 * (the active connection's schema list) and `repoPath`. The schema
 * list is materialised inside the Database host via
 * `useActiveConnection`. Until that hook is reachable through the
 * dispatcher context, Phase 1b renders a placeholder.
 *
 * TODO(phase-2): expose the active connection's table list through
 * the dispatcher context so this renderer can mount standalone.
 */
import React, { memo } from "react";

import type { UnifiedTabContentProps } from "../types";
import { HostCoupledPlaceholder } from "./HostCoupledPlaceholder";

const TableTabRenderer: React.FC<UnifiedTabContentProps> = memo(({ tab }) => (
  <HostCoupledPlaceholder
    tabType={tab.type}
    title={String(tab.title ?? "Table")}
    hostNote="Database table view still rendered by the Database Manager host (needs active connection schema). Phase 2 will lift this through the dispatcher context."
  />
));

TableTabRenderer.displayName = "TableTabRenderer";

export default TableTabRenderer;

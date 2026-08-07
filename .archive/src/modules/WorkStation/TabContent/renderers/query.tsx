/**
 * Renderer wrapper for `query` (database SQL editor) tabs.
 *
 * Today the SQL editor view is mounted inside `DatabaseMainPane` in
 * `viewMode === "query"`, sharing the same `connectionId` and query
 * history hooks. The standalone path will need the dispatcher to
 * provide the active connection + query-history bridge.
 *
 * TODO(phase-2): split the SQL editor view out of `DatabaseMainPane`
 * and let it consume the active connection from the dispatcher
 * context.
 */
import React, { memo } from "react";

import type { UnifiedTabContentProps } from "../types";
import { HostCoupledPlaceholder } from "./HostCoupledPlaceholder";

const QueryTabRenderer: React.FC<UnifiedTabContentProps> = memo(({ tab }) => (
  <HostCoupledPlaceholder
    tabType={tab.type}
    title={String(tab.title ?? "Query")}
    hostNote="SQL query editor still rendered by the Database Manager host. Phase 2 will split it out and route the active connection through the dispatcher context."
  />
));

QueryTabRenderer.displayName = "QueryTabRenderer";

export default QueryTabRenderer;

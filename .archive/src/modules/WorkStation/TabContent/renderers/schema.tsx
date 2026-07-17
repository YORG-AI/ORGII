/**
 * Renderer wrapper for `schema` (database schema viewer) tabs.
 *
 * Schema viewer is currently rendered inline by the Database host
 * using the active connection's metadata. Phase 1b renders a
 * placeholder until the dispatcher context exposes the active
 * connection.
 *
 * TODO(phase-2): extract the schema viewer from `DatabaseMainPane`
 * and let it consume the active connection from the dispatcher
 * context.
 */
import React, { memo } from "react";

import type { UnifiedTabContentProps } from "../types";
import { HostCoupledPlaceholder } from "./HostCoupledPlaceholder";

const SchemaTabRenderer: React.FC<UnifiedTabContentProps> = memo(({ tab }) => (
  <HostCoupledPlaceholder
    tabType={tab.type}
    title={String(tab.title ?? "Schema")}
    hostNote="Database schema viewer still rendered by the Database Manager host. Phase 2 will expose the active connection through the dispatcher context."
  />
));

SchemaTabRenderer.displayName = "SchemaTabRenderer";

export default SchemaTabRenderer;

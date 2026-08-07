/**
 * Renderer wrapper for `add-connection` (database) tabs.
 *
 * The add-connection wizard is currently mounted by the Database host
 * with several callbacks (test/save connection, refresh sidebar). Phase 1b
 * renders a placeholder until the dispatcher context can supply those
 * wires.
 *
 * TODO(phase-2): expose the connection mutation callbacks through the
 * dispatcher context.
 */
import React, { memo } from "react";

import type { UnifiedTabContentProps } from "../types";
import { HostCoupledPlaceholder } from "./HostCoupledPlaceholder";

const AddConnectionTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => (
    <HostCoupledPlaceholder
      tabType={tab.type}
      title={String(tab.title ?? "Add Connection")}
      hostNote="Database add-connection wizard still rendered by the Database Manager host. Phase 2 will expose the connection mutation callbacks through the dispatcher context."
    />
  )
);

AddConnectionTabRenderer.displayName = "AddConnectionTabRenderer";

export default AddConnectionTabRenderer;

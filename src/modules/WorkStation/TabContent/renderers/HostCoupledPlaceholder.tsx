/**
 * Shared placeholder used by Phase 1b renderer wrappers whose underlying
 * component cannot be rendered standalone yet because it depends on
 * host-owned context (file-content manager, gitFilesByPath, terminal
 * state, action-system registrations, etc.).
 *
 * Phase 2 replaces these stubs with the real prop-adapted render once
 * AppShell collapses around `UnifiedTabContent` and the host context
 * sits above the dispatcher.
 *
 * This component is not user-facing in Phase 1b — the registry exists
 * but is not imported by AppShell. It will become user-visible when
 * Phase 2 wires `UnifiedTabContent` in.
 */
import React, { memo } from "react";

import { Placeholder } from "@src/components/Placeholder";

interface HostCoupledPlaceholderProps {
  tabType: string;
  title?: string;
  hostNote: string;
}

export const HostCoupledPlaceholder: React.FC<HostCoupledPlaceholderProps> =
  memo(({ tabType, title, hostNote }) => (
    <Placeholder
      variant="empty"
      placement="detail-panel"
      title={title || tabType}
      subtitle={hostNote}
      fillParentHeight
    />
  ));

HostCoupledPlaceholder.displayName = "HostCoupledPlaceholder";

export default HostCoupledPlaceholder;

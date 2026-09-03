/**
 * DetailPanelContainer
 *
 * Standard outer wrapper for detail panels in list-detail layouts.
 * Includes the responsive narrow-placeholder pattern: when the panel
 * is narrower than 300px a "resize" placeholder is shown instead of
 * the content, matching the Settings page behavior.
 *
 * Breakpoint is 300px (below the typical 320px min-width of split panels).
 *
 * Replaces raw `<div className={DETAIL_PANEL_TOKENS.container}>`.
 */
import React, { memo } from "react";

import NarrowPlaceholder from "../NarrowPlaceholder";

export interface DetailPanelContainerProps {
  children: React.ReactNode;
  className?: string;
  /** Optional stable test id for E2E specs to assert which detail view is mounted. */
  testId?: string;
  rootProps?: React.HTMLAttributes<HTMLDivElement>;
  dataAttributes?: Record<
    `data-${string}`,
    boolean | number | string | undefined
  >;
}

const DetailPanelContainer: React.FC<DetailPanelContainerProps> = memo(
  ({ children, className = "", testId, rootProps, dataAttributes }) => (
    <div
      {...rootProps}
      {...dataAttributes}
      className={`@container flex h-full min-w-0 flex-col overflow-hidden ${className}`}
      data-testid={testId}
    >
      <NarrowPlaceholder className="flex-1 @[300px]:hidden" />
      <div className="hidden h-full flex-col overflow-hidden @[300px]:flex">
        {children}
      </div>
    </div>
  )
);

DetailPanelContainer.displayName = "DetailPanelContainer";

export default DetailPanelContainer;

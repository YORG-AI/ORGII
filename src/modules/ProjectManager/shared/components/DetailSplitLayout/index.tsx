/**
 * DetailSplitLayout Component
 *
 * Reusable layout for detail/creation panels in Project Manager.
 * Provides:
 *   - Header with breadcrumb or title, optional nav + actions (shared tokens)
 *   - Split panel: left content area + right sidebar (280px)
 *   - Optional footer
 *
 * Used by:
 *   - WorkItemDetail (view/edit)
 *   - CreateProjectView (create)
 *   - CreateWorkItemView (create)
 */
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  HEADER_CLASSES,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import { useResizeHandle } from "@src/hooks/ui/useResizeHandle";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  HugeiconsIcon,
} from "@src/icons";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import { PANEL_FOOTER_TOKENS } from "@src/modules/shared/layouts/blocks";
import { VerticalResizeHandle } from "@src/scaffold/Resize";

// ============================================
// Types
// ============================================

export interface DetailSplitLayoutProps {
  /** Title shown in the header (used when no breadcrumb is provided) */
  title: string;
  /** Optional breadcrumb segments displayed before the title (e.g. ["Repo", "New Project"]) */
  breadcrumb?: React.ReactNode[];
  /** Remove the default bottom border from the local header row. */
  borderlessHeader?: boolean;
  /** Hide the local header row entirely. */
  hideHeader?: boolean;
  /** Optional navigation callback (renders prev/next arrows) */
  onNavigate?: (direction: "prev" | "next") => void;
  /** Whether previous navigation is available */
  hasPrev?: boolean;
  /** Whether next navigation is available */
  hasNext?: boolean;
  /** Optional extra actions rendered in the header (e.g. delete button) */
  headerActions?: React.ReactNode;
  /** Optional full-width content rendered above the detail body. */
  topContent?: React.ReactNode;
  /** Left panel content (main content area) */
  leftContent: React.ReactNode;
  /** Right panel content (properties sidebar) */
  rightContent?: React.ReactNode;
  /** Enable horizontal resizing for the right panel. */
  resizableRightPanel?: boolean;
  /** Initial right panel width when resizing is enabled. */
  defaultRightPanelWidth?: number;
  /** Minimum right panel width when resizing is enabled. */
  minRightPanelWidth?: number;
  /** Maximum right panel width when resizing is enabled. */
  maxRightPanelWidth?: number;
  /** Optional footer (e.g. Cancel / Create buttons) */
  footer?: React.ReactNode;
  /** Publish header content into the global WorkstationTabHeader instead of rendering an inline row. */
  publishHeaderToWorkstation?: boolean;
}

// ============================================
// Component
// ============================================

const DETAIL_SPLIT_DEFAULT_RIGHT_PANEL_WIDTH = 280;
const DETAIL_SPLIT_MIN_RIGHT_PANEL_WIDTH = 250;
const DETAIL_SPLIT_MAX_RIGHT_PANEL_WIDTH = 420;

const DetailSplitLayout: React.FC<DetailSplitLayoutProps> = ({
  title,
  breadcrumb,
  borderlessHeader = false,
  hideHeader = false,
  onNavigate,
  hasPrev = false,
  hasNext = false,
  headerActions,
  topContent,
  leftContent,
  rightContent,
  resizableRightPanel = false,
  defaultRightPanelWidth = DETAIL_SPLIT_DEFAULT_RIGHT_PANEL_WIDTH,
  minRightPanelWidth = DETAIL_SPLIT_MIN_RIGHT_PANEL_WIDTH,
  maxRightPanelWidth = DETAIL_SPLIT_MAX_RIGHT_PANEL_WIDTH,
  footer,
  publishHeaderToWorkstation = false,
}) => {
  const { t } = useTranslation();
  const [rightPanelWidth, setRightPanelWidth] = useState(
    defaultRightPanelWidth
  );
  const handleRightPanelWidthChange = useCallback(
    (nextWidth: number) => setRightPanelWidth(nextWidth),
    []
  );
  const { handleMouseDown: handleRightPanelResize, isResizing } =
    useResizeHandle(rightPanelWidth, handleRightPanelWidthChange, {
      direction: "horizontal",
      minSize: minRightPanelWidth,
      maxSize: maxRightPanelWidth,
      isReversed: true,
    });

  const primitiveBreadcrumb =
    breadcrumb &&
    breadcrumb.length > 0 &&
    breadcrumb.every(
      (segment) => typeof segment === "string" || typeof segment === "number"
    )
      ? breadcrumb.map((segment) => ({ label: String(segment) }))
      : null;
  const headerContent = primitiveBreadcrumb ? (
    <ProjectManagerBreadcrumb segments={primitiveBreadcrumb} />
  ) : breadcrumb && breadcrumb.length > 0 ? (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      {breadcrumb.map((segment, index) => {
        const isLeaf = index === breadcrumb.length - 1;
        return (
          <React.Fragment key={index}>
            {index > 0 && (
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={14}
                strokeWidth={1.75}
                className="mx-1 shrink-0 text-fill-4"
              />
            )}
            <div
              className={
                breadcrumb.length === 1 && isLeaf
                  ? "min-w-0 flex-1 text-[13px]"
                  : "min-w-0 shrink-0 text-[13px]"
              }
            >
              {segment}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  ) : (
    <ProjectManagerBreadcrumb segments={[{ label: title }]} />
  );

  const headerTrailing = (
    <div className="flex shrink-0 items-center gap-px">
      {headerActions}
      {headerActions && onNavigate && (
        <div
          className="pointer-events-none mx-1.5 h-4 w-px shrink-0 bg-border-2"
          role="separator"
          aria-hidden
        />
      )}
      {onNavigate && (
        <>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={() => onNavigate("prev")}
            disabled={!hasPrev}
            title={t("actions.previous")}
            icon={
              <HugeiconsIcon
                icon={ArrowUp01Icon}
                data-icon="chevron-up"
                size={HEADER_ICON_SIZE.sm}
              />
            }
          />
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={() => onNavigate("next")}
            disabled={!hasNext}
            title={t("actions.next")}
            icon={
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={HEADER_ICON_SIZE.sm}
              />
            }
          />
        </>
      )}
    </div>
  );

  usePublishWorkstationTabHeader({
    host: "project",
    content: { content: headerContent, trailing: headerTrailing },
    enabled: publishHeaderToWorkstation,
  });

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      {!publishHeaderToWorkstation && !hideHeader && (
        <div
          className={
            borderlessHeader
              ? HEADER_CLASSES.pageHeader.replace(
                  "border-b border-border-2",
                  ""
                )
              : HEADER_CLASSES.pageHeader
          }
        >
          {headerContent}
          {headerTrailing}
        </div>
      )}

      {topContent && (
        <div className="shrink-0 border-b border-border-2">{topContent}</div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`min-w-0 flex-1 overflow-hidden ${rightContent && !resizableRightPanel ? "border-r border-border-2" : ""}`}
        >
          {leftContent}
        </div>

        {rightContent && resizableRightPanel && (
          <VerticalResizeHandle
            onMouseDown={handleRightPanelResize}
            isResizing={isResizing}
          />
        )}

        {rightContent && (
          <div
            className={
              resizableRightPanel
                ? "min-w-0 shrink-0 overflow-hidden"
                : "w-[280px] max-w-[300px] min-w-[250px] shrink-0"
            }
            style={resizableRightPanel ? { width: rightPanelWidth } : undefined}
          >
            {rightContent}
          </div>
        )}
      </div>

      {footer && (
        <div className={`${PANEL_FOOTER_TOKENS.container} justify-end`}>
          {footer}
        </div>
      )}
    </div>
  );
};

export default DetailSplitLayout;

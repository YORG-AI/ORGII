/**
 * ProjectsPageHeader Component
 *
 * Header for the Projects page with breadcrumb and action buttons.
 * Uses shared WorkStation header tokens for consistent styling.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import {
  HEADER_CLASSES,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import {
  type WorkstationTabHeaderHost,
  usePublishWorkstationTabHeader,
} from "@src/hooks/tabHost/useWorkstationTabHeader";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  Add01Icon,
  BoxesIcon,
  HugeiconsIcon,
  ListChevronsDownUpIcon,
  Refresh04Icon,
  Search01Icon,
} from "@src/icons";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";

// ============================================
// Types
// ============================================

export interface ProjectsPageHeaderProps {
  /** Page title to display in the breadcrumb */
  title: string;
  breadcrumbSegments?: readonly ProjectManagerBreadcrumbSegment[];
  /** Callback when search button is clicked (opens PageSearch) */
  onSearch?: () => void;
  /** Collapse every visible project group. */
  onCollapseAll?: () => void;
  /** Callback when refresh button is clicked */
  onRefresh?: () => void;
  onAddProject?: () => void;
  /** Whether refresh is in progress (for spin animation) */
  refreshLoading?: boolean;
  /** Additional controls shown next to the title on the left side. */
  leadingControls?: React.ReactNode;
  /** Additional controls shown at the right end of the 40px header. */
  trailingControls?: React.ReactNode;
  /** Publish controls into the global WorkstationTabHeader instead of rendering an inline 40px row. */
  publishToWorkstationHeader?: boolean;
  /** Target workstation host slot for the published header. */
  workstationHeaderHost?: WorkstationTabHeaderHost;
  /** Optional custom className */
  className?: string;
}

// ============================================
// Component
// ============================================

const ProjectsPageHeader: React.FC<ProjectsPageHeaderProps> = ({
  title,
  breadcrumbSegments,
  onSearch,
  onCollapseAll,
  onRefresh,
  onAddProject,
  refreshLoading = false,
  leadingControls,
  trailingControls,
  publishToWorkstationHeader = false,
  workstationHeaderHost = "project",
  className = "",
}) => {
  const { t } = useTranslation("projects");
  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(onRefresh ?? (() => {}), refreshLoading);
  const resolvedBreadcrumbSegments = useMemo(() => {
    const segments = breadcrumbSegments ?? [{ label: title }];
    return segments.map((segment, index) =>
      index === segments.length - 1
        ? {
            ...segment,
            icon: segment.icon ?? (
              <HugeiconsIcon
                icon={BoxesIcon}
                data-icon="boxes"
                size={HEADER_ICON_SIZE.sm}
                strokeWidth={1.75}
              />
            ),
          }
        : segment
    );
  }, [breadcrumbSegments, title]);

  const headerContent =
    resolvedBreadcrumbSegments.length === 0 ? (
      leadingControls ? (
        <div className="contents">{leadingControls}</div>
      ) : null
    ) : (
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <ProjectManagerBreadcrumb
          segments={resolvedBreadcrumbSegments}
          trailingNode={leadingControls}
        />
      </div>
    );

  const headerTrailing = (
    <div className="flex flex-shrink-0 items-center gap-px">
      {trailingControls}
      {trailingControls &&
        (onSearch || onCollapseAll || onRefresh || onAddProject) && (
          <HeaderSectionSeparator className="mx-1" />
        )}
      {onSearch && (
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          onClick={onSearch}
          title={t("common:actions.search")}
          icon={
            <HugeiconsIcon
              icon={Search01Icon}
              data-icon="search"
              size={HEADER_ICON_SIZE.sm}
              strokeWidth={2}
            />
          }
        />
      )}
      {(onCollapseAll || onRefresh || onAddProject) && (
        <div className="flex flex-shrink-0 items-center gap-px">
          {onCollapseAll && (
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              onClick={onCollapseAll}
              title={t("common:actions.collapseAll")}
              icon={
                <HugeiconsIcon
                  icon={ListChevronsDownUpIcon}
                  data-icon="list-chevrons-down-up"
                  size={HEADER_ICON_SIZE.md}
                  strokeWidth={2}
                />
              }
            />
          )}
          {onRefresh && (
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              onClick={handleRefreshClick}
              title={t("common:actions.refresh")}
              icon={
                <HugeiconsIcon
                  icon={Refresh04Icon}
                  data-icon="refresh-cw"
                  size={HEADER_ICON_SIZE.sm}
                  strokeWidth={2}
                  className={refreshSpinClass}
                />
              }
            />
          )}
          {onAddProject && (
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              onClick={onAddProject}
              title={t("projects.createProject")}
              data-testid="projects-create-project"
              icon={
                <HugeiconsIcon
                  icon={Add01Icon}
                  data-icon="plus"
                  size={HEADER_ICON_SIZE.md}
                  strokeWidth={2}
                />
              }
            />
          )}
        </div>
      )}
    </div>
  );

  usePublishWorkstationTabHeader({
    host: workstationHeaderHost,
    content: { content: headerContent, trailing: headerTrailing },
    enabled: publishToWorkstationHeader,
  });

  if (publishToWorkstationHeader) return null;

  return (
    <div className={`${HEADER_CLASSES.pageHeader} ${className}`}>
      {headerContent}
      {headerTrailing}
    </div>
  );
};

export default ProjectsPageHeader;

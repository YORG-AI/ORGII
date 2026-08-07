/**
 * ProjectsPageHeader Component
 *
 * Header for the Projects page with breadcrumb and action buttons.
 * Uses shared WorkStation header tokens for consistent styling.
 */
import { ListChevronsDownUp, Plus, RefreshCw, Search } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  HEADER_CLASSES,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  type WorkstationTabHeaderHost,
  usePublishWorkstationTabHeader,
} from "@src/hooks/workStation";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import { WorkstationHeaderSectionSeparator } from "@src/modules/WorkStation/shared";

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
  const resolvedBreadcrumbSegments = useMemo(
    () => breadcrumbSegments ?? [{ label: title }],
    [breadcrumbSegments, title]
  );

  const renderHeaderContent = (includeRefresh: boolean) => (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <ProjectManagerBreadcrumb
          segments={resolvedBreadcrumbSegments}
          trailingNode={leadingControls}
        />
      </div>

      <div className="flex flex-shrink-0 items-center gap-px">
        {trailingControls}
        {trailingControls &&
          (onSearch ||
            onCollapseAll ||
            (includeRefresh && onRefresh) ||
            onAddProject) && (
            <WorkstationHeaderSectionSeparator className="mx-1" />
          )}
        {onSearch && (
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={onSearch}
            title={t("common:actions.search")}
            icon={<Search size={HEADER_ICON_SIZE.sm} strokeWidth={2} />}
          />
        )}
        {(onCollapseAll || (includeRefresh && onRefresh) || onAddProject) && (
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
                  <ListChevronsDownUp
                    size={HEADER_ICON_SIZE.md}
                    strokeWidth={2}
                  />
                }
              />
            )}
            {includeRefresh && onRefresh && (
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                onClick={handleRefreshClick}
                title={t("common:actions.refresh")}
                icon={
                  <RefreshCw
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
                icon={<Plus size={HEADER_ICON_SIZE.md} strokeWidth={2} />}
              />
            )}
          </div>
        )}
      </div>
    </>
  );

  const publishedHeaderContent = renderHeaderContent(true);
  const inlineHeaderContent = renderHeaderContent(true);

  usePublishWorkstationTabHeader({
    host: workstationHeaderHost,
    content: { content: publishedHeaderContent },
    enabled: publishToWorkstationHeader,
  });

  if (publishToWorkstationHeader) return null;

  return (
    <div className={`${HEADER_CLASSES.pageHeader} ${className}`}>
      {inlineHeaderContent}
    </div>
  );
};

export default ProjectsPageHeader;

import React from "react";

import BreadcrumbFileHeader from "@src/modules/shared/components/FileHeader/BreadcrumbFileHeader";

export interface ProjectManagerBreadcrumbSegment {
  label: string;
  content?: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  title?: string;
  maxCharacters?: number;
  /** Keep the full label and let this segment consume the remaining row width. */
  fillAvailableWidth?: boolean;
}

interface ProjectManagerBreadcrumbProps {
  segments: readonly ProjectManagerBreadcrumbSegment[];
  trailingNode?: React.ReactNode;
}

const PROJECT_MANAGER_SINGLE_LEVEL_MAX_CHARACTERS = 40;
const PROJECT_MANAGER_PARENT_MAX_CHARACTERS = 24;
const PROJECT_MANAGER_LEAF_MAX_CHARACTERS = 36;

export function truncateProjectManagerHeaderLabel(
  label: string,
  maxCharacters: number
): string {
  const characters = Array.from(label);
  if (characters.length <= maxCharacters) return label;
  if (maxCharacters <= 1) return "…";
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

export const ProjectManagerBreadcrumb: React.FC<
  ProjectManagerBreadcrumbProps
> = ({ segments, trailingNode }) => {
  const visibleSegments = segments.filter((segment) => segment.label.trim());
  const breadcrumbIcon = visibleSegments.find((segment) => segment.icon)?.icon;
  const displaySegments = visibleSegments.map((segment, index) => {
    const isLeaf = index === visibleSegments.length - 1;
    const defaultMaxCharacters =
      visibleSegments.length === 1
        ? PROJECT_MANAGER_SINGLE_LEVEL_MAX_CHARACTERS
        : isLeaf
          ? PROJECT_MANAGER_LEAF_MAX_CHARACTERS
          : PROJECT_MANAGER_PARENT_MAX_CHARACTERS;

    return {
      ...segment,
      icon: index === 0 ? breadcrumbIcon : undefined,
      label: segment.fillAvailableWidth
        ? segment.label
        : truncateProjectManagerHeaderLabel(
            segment.label,
            segment.maxCharacters ?? defaultMaxCharacters
          ),
      title: segment.title ?? segment.label,
    };
  });
  const filePath = visibleSegments.map((segment) => segment.label).join("/");

  if (!filePath && !trailingNode) return null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {filePath && (
        <BreadcrumbFileHeader
          filePath={filePath}
          displaySegments={displaySegments}
          disableNavigation
          className="!flex-1"
        />
      )}
      {trailingNode && filePath && (
        <span
          className="pointer-events-none mx-1 h-4 w-px flex-shrink-0 bg-border-2"
          role="separator"
          aria-hidden
        />
      )}
      {trailingNode && (
        <span className="inline-flex h-6 flex-shrink-0 items-center gap-2">
          {trailingNode}
        </span>
      )}
    </div>
  );
};

export default ProjectManagerBreadcrumb;

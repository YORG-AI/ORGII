/**
 * ProjectPropertiesPanel
 *
 * Right-side panel for Project Manager showing project properties.
 * Follows the same pattern as Browser's WebInspector / WebDevTools:
 * - Collapsed: narrow strip with toggle button
 * - Expanded: PropertiesPanel shell (header + scrollable content)
 *
 * Data is passed as props from ProjectManagerLayout (lifted state pattern,
 * matching how BrowserLayout passes data to WebInspector).
 * Width and resize are handled by WorkStationShell, not this component.
 */
import React, { memo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { HEADER_BUTTON } from "@src/config/workstation/tokens";
import { HugeiconsIcon, PanelRightOpenIcon } from "@src/icons";
import type {
  LinkedRepoOption,
  ProjectData,
} from "@src/modules/ProjectManager/shared";
import {
  ProjectPropertyFields,
  PropertiesPanel,
} from "@src/modules/ProjectManager/shared";
import type { Label, Person, Team } from "@src/types/core/shared";

// ============================================
// Types
// ============================================

export interface ProjectPropertiesPanelProps {
  /** Whether panel is collapsed */
  isCollapsed: boolean;
  /** Toggle panel collapse/expand */
  onToggleCollapse: () => void;
  /** Project data to display (null when no project tab is active) */
  project: ProjectData | null;
  /** Available members for pickers */
  availableMembers: Person[];
  /** Available teams for pickers */
  availableTeams: Team[];
  /** Available labels for pickers */
  availableLabels: Label[];
  /** Available repos for the linked-repos picker (omit to hide the field) */
  availableRepos?: LinkedRepoOption[];
  /** Callback when a property is updated in the project store */
  onUpdate: (updates: Partial<ProjectData>) => Promise<boolean>;
}

// ============================================
// Component
// ============================================

const ProjectPropertiesPanel: React.FC<ProjectPropertiesPanelProps> = memo(
  ({
    isCollapsed,
    onToggleCollapse,
    project,
    availableMembers,
    availableTeams,
    availableLabels,
    availableRepos,
    onUpdate,
  }) => {
    const { t } = useTranslation("projects");
    const containerRef = useRef<HTMLElement>(null);

    // ---- Collapsed state: narrow strip with toggle ----
    if (isCollapsed) {
      return (
        <div className="flex h-full w-8 shrink-0 flex-col items-center bg-bg-1 pt-2">
          <button
            className={HEADER_BUTTON.actionLg}
            onClick={onToggleCollapse}
            title={t("workItems.showProperties")}
          >
            <HugeiconsIcon
              icon={PanelRightOpenIcon}
              data-icon="panel-right-open"
              size={16}
            />
          </button>
        </div>
      );
    }

    // ---- Expanded state: PropertiesPanel shell handles header + scroll ----
    return (
      <div className="relative flex h-full w-full flex-col">
        {project ? (
          <PropertiesPanel containerRef={containerRef}>
            <ProjectPropertyFields
              project={project}
              onUpdate={onUpdate}
              availableMembers={availableMembers}
              availableTeams={availableTeams}
              availableLabels={availableLabels}
              availableRepos={availableRepos}
              containerRef={containerRef}
            />
          </PropertiesPanel>
        ) : (
          <Placeholder
            variant="empty"
            title={t("properties.noProjectSelected")}
          />
        )}
      </div>
    );
  }
);

ProjectPropertiesPanel.displayName = "ProjectPropertiesPanel";

export default ProjectPropertiesPanel;

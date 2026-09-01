import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type LinkedRepoOption,
  PROJECT_PROPERTY_CONCISE_FIELDS,
  ProjectContentEditor,
  type ProjectData,
  ProjectPropertyFields,
} from "@src/modules/ProjectManager/shared";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
} from "@src/modules/shared/layouts/blocks";
import type { Label, Person, Team } from "@src/types/core/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

export interface OverviewStats {
  total: number;
  inProgress: number;
  completed: number;
  completionRate: number;
}

interface WorkItemsOverviewProps {
  workItems: WorkItemExtended[];
  projectName: string;
  projectDescription?: string;
  availableMembers?: Person[];
  availableTeams?: Team[];
  availableLabels?: Label[];
  availableRepos?: LinkedRepoOption[];
  projectProperties?: ProjectData;
  onProjectPropertiesChange?: (updates: Partial<ProjectData>) => void;
  precomputedStats?: OverviewStats;
  onProjectNameChange?: (name: string) => void;
  onProjectDescriptionChange?: (html: string, text: string) => void;
  repoPath?: string | null;
  hideProjectPropertiesRow?: boolean;
  headerActions?: React.ReactNode;
  className?: string;
}

const WorkItemsOverview: React.FC<WorkItemsOverviewProps> = ({
  projectName,
  projectDescription,
  availableMembers = [],
  availableTeams = [],
  availableLabels = [],
  availableRepos = [],
  projectProperties,
  onProjectPropertiesChange,
  onProjectNameChange,
  onProjectDescriptionChange,
  repoPath,
  hideProjectPropertiesRow = false,
  headerActions,
  className = "",
}) => {
  const { t } = useTranslation("projects");
  const [localProjectName, setLocalProjectName] = useState(projectName);
  const propertiesRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setLocalProjectName(projectName);
  }, [projectName]);

  const handleProjectNameChange = useCallback(
    (name: string) => {
      setLocalProjectName(name);
      onProjectNameChange?.(name);
    },
    [onProjectNameChange]
  );

  const handleDescriptionChange = useCallback(
    (markdown: string, text: string) => {
      onProjectDescriptionChange?.(markdown, text);
    },
    [onProjectDescriptionChange]
  );

  return (
    <DetailPanelContainer
      className={className || undefined}
      testId="work-items-overview"
    >
      <div className="shrink-0 px-3 pt-4">
        <ProjectContentEditor
          title={localProjectName}
          onTitleChange={handleProjectNameChange}
          initialDescription={projectDescription ?? ""}
          onDescriptionChange={handleDescriptionChange}
          titlePlaceholder={t("workItems.overview.projectNamePlaceholder")}
          descriptionPlaceholder={t(
            "workItems.overview.descriptionPlaceholder"
          )}
          editable={!!onProjectNameChange}
          repoPath={repoPath}
          titleActions={headerActions}
          metaContent={
            projectProperties && !hideProjectPropertiesRow ? (
              <div className="[&_[data-property-dropdown]]:!top-full [&_[data-property-dropdown]]:!mt-1">
                <ProjectPropertyFields
                  project={projectProperties}
                  onUpdate={onProjectPropertiesChange}
                  availableMembers={availableMembers}
                  availableTeams={availableTeams}
                  availableLabels={availableLabels}
                  availableRepos={availableRepos}
                  containerRef={propertiesRef}
                  fieldVariant="pill"
                  visibleFields={PROJECT_PROPERTY_CONCISE_FIELDS}
                  showMoreMenu
                />
              </div>
            ) : undefined
          }
          descriptionVisible={false}
          className="flex flex-col"
        />
      </div>

      <div className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div className={DETAIL_PANEL_TOKENS.sectionGap}>
          <ProjectContentEditor
            title={localProjectName}
            onTitleChange={handleProjectNameChange}
            initialDescription={projectDescription ?? ""}
            onDescriptionChange={handleDescriptionChange}
            titlePlaceholder={t("workItems.overview.projectNamePlaceholder")}
            descriptionPlaceholder={t(
              "workItems.overview.descriptionPlaceholder"
            )}
            editable={!!onProjectDescriptionChange}
            titleVisible={false}
            separatorVisible={false}
            descriptionClassName="no-bottom-border"
            repoPath={repoPath}
          />
        </div>
      </div>
    </DetailPanelContainer>
  );
};

export default WorkItemsOverview;

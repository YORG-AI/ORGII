import type { TFunction } from "i18next";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import { type ProjectOrg, projectApi } from "@src/api/http/project";
import { projectSyncApi } from "@src/api/http/project/sync";
import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import Message from "@src/components/Message";
import type { SelectOption } from "@src/components/Select";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { useProjectOrgCloudPermissions } from "@src/features/Org2Cloud/useProjectOrgCloudPermissions";
import { createLogger } from "@src/hooks/logger";
import {
  ArrowRightDoubleIcon,
  HugeiconsIcon,
  InformationCircleIcon,
} from "@src/icons";
import { filterSelectableProjectOrgs } from "@src/modules/ProjectManager/projectOrgVisibility";
import {
  type ProjectData,
  ProjectOrganizationField,
  ProjectPropertyFields,
  PropertiesPanel,
  PropertiesRailFrame,
} from "@src/modules/ProjectManager/shared";
import {
  WorkstationTrailIconButton,
  WorkstationTrailSurface,
} from "@src/modules/shared/layouts/blocks";
import { openProjectInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { ChatPanelSelectedProject } from "@src/store/ui/chatPanelAtom";

const logger = createLogger("ProjectPanelView");

/** Owns organization moves, sync visibility, and the properties rail without hiding their state. */
export function useProjectProperties(
  selectedProject: ChatPanelSelectedProject,
  t: TFunction<["projects", "common"]>
) {
  const openProjectTab = useSetAtom(openProjectInChatPanelTabAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const { canAdminister } = useProjectOrgCloudPermissions();
  const [projectSyncAdapter, setProjectSyncAdapter] = useState<{
    projectSlug: string;
    adapterId: string | null;
  } | null>(null);
  const [projectOrgs, setProjectOrgs] = useState<ProjectOrg[]>([]);
  const [movingProject, setMovingProject] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const propertiesRef = useRef<HTMLElement>(null);

  const projectProperties = useMemo<ProjectData>(
    () => ({
      id: selectedProject.project.id,
      name: selectedProject.project.name,
      description: selectedProject.project.description,
      slug: selectedProject.project.slug,
      workItemPrefix: selectedProject.project.workItemPrefix,
      workItemPrefixCustom: selectedProject.project.workItemPrefixCustom,
      status: selectedProject.project.status,
      priority: selectedProject.project.priority,
      health: selectedProject.project.health,
      lead: selectedProject.project.lead,
      members: selectedProject.project.members,
      teams: selectedProject.project.teams,
      labels: selectedProject.project.labels,
      linkedRepos: selectedProject.project.linkedRepos?.map((repo) => ({
        id: repo.id,
        name: repo.name,
      })),
      startDate: selectedProject.project.startDate,
      targetDate: selectedProject.project.targetDate,
      completionPercentage: selectedProject.project.completionPercentage,
      statusBreakdown: selectedProject.project.statusBreakdown,
    }),
    [selectedProject.project]
  );
  const projectSlug =
    selectedProject.projectSlug || selectedProject.project.slug;
  const projectSyncAdapterId =
    projectSyncAdapter && projectSyncAdapter.projectSlug === projectSlug
      ? projectSyncAdapter.adapterId
      : selectedProject.projectSyncAdapterId;
  const isGitHubSyncedProject =
    projectSyncAdapterId === STORY_SYNC_ADAPTER.GITHUB;
  const toggleProperties = useCallback(() => {
    setPropertiesOpen((current) => !current);
  }, []);
  const propertiesToggleLabel = propertiesOpen
    ? t("projects:workItems.hideProperties")
    : t("projects:workItems.showProperties");
  const headerTrailing = useMemo(
    () => (
      <ToolbarTooltip label={propertiesToggleLabel}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          className={
            propertiesOpen ? "bg-surface-selected! text-primary-6!" : ""
          }
          onClick={toggleProperties}
          aria-label={propertiesToggleLabel}
          data-testid="chat-panel-project-properties-toggle"
          icon={
            <HugeiconsIcon
              icon={InformationCircleIcon}
              data-icon="info"
              size={HEADER_ICON_SIZE.sm}
            />
          }
        />
      </ToolbarTooltip>
    ),
    [propertiesOpen, propertiesToggleLabel, toggleProperties]
  );

  useEffect(() => {
    if (!projectSlug) return;

    let cancelled = false;
    void projectSyncApi
      .status(projectSlug)
      .then((status) => {
        if (!cancelled) {
          setProjectSyncAdapter({
            projectSlug,
            adapterId: status.adapter_id,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectSyncAdapter({ projectSlug, adapterId: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectSlug]);

  const loadProjectOrgs = useCallback(async () => {
    try {
      setProjectOrgs(await projectApi.readOrgs());
    } catch (error) {
      logger.warn("Failed to load project organizations", error);
    }
  }, []);

  useEffect(() => {
    void loadProjectOrgs();
  }, [loadProjectOrgs]);

  const selectableProjectOrgs = useMemo(
    () => filterSelectableProjectOrgs(projectOrgs, cloudOrgs),
    [cloudOrgs, projectOrgs]
  );
  const projectOrgOptions = useMemo<SelectOption[]>(
    () =>
      selectableProjectOrgs.map((org) => ({
        value: org.id,
        label: org.name,
        triggerLabel: org.name,
        dataTestId: `project-org-option-${org.id}`,
      })),
    [selectableProjectOrgs]
  );
  const canMoveProject = canAdminister(selectedProject.orgId);
  const selectedProjectOrgLabel =
    selectableProjectOrgs.find((org) => org.id === selectedProject.orgId)
      ?.name ??
    selectedProject.orgName ??
    selectedProject.orgId;

  const handleProjectOrgChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value) || movingProject || !projectSlug) return;
      const destinationOrgId = String(value);
      if (destinationOrgId === selectedProject.orgId) return;

      void (async () => {
        setMovingProject(true);
        try {
          await projectApi.moveProject(projectSlug, destinationOrgId);
          const destinationOrg = selectableProjectOrgs.find(
            (org) => org.id === destinationOrgId
          );
          openProjectTab({
            ...selectedProject,
            orgId: destinationOrgId,
            orgName: destinationOrg?.name ?? destinationOrgId,
          });
          Message.success(
            `Moved project to ${destinationOrg?.name ?? destinationOrgId}`
          );
        } catch (error) {
          logger.error("Failed to move project", error);
          Message.error(
            error instanceof Error ? error.message : "Failed to move project"
          );
        } finally {
          setMovingProject(false);
        }
      })();
    },
    [
      movingProject,
      openProjectTab,
      projectSlug,
      selectableProjectOrgs,
      selectedProject,
    ]
  );

  const propertiesPanel = (
    <PropertiesRailFrame
      width={300}
      minWidth={280}
      maxWidth={320}
      floatingContent
    >
      <WorkstationTrailSurface className="flex self-start">
        <PropertiesPanel
          title={t("projects:properties.projectProperties")}
          containerRef={propertiesRef}
          fitContent
          headerVariant="workstation-trail"
          headerActions={
            <ToolbarTooltip label={propertiesToggleLabel}>
              <WorkstationTrailIconButton
                onClick={toggleProperties}
                aria-label={propertiesToggleLabel}
                data-testid="chat-panel-project-properties-collapse"
              >
                <HugeiconsIcon
                  icon={ArrowRightDoubleIcon}
                  data-icon="chevrons-right"
                  size={14}
                  strokeWidth={1.75}
                />
              </WorkstationTrailIconButton>
            </ToolbarTooltip>
          }
        >
          <div
            title={
              canMoveProject
                ? undefined
                : "Only an organization owner or admin can move this project"
            }
          >
            <ProjectOrganizationField
              value={selectedProject.orgId}
              valueLabel={selectedProjectOrgLabel}
              options={projectOrgOptions}
              onChange={handleProjectOrgChange}
              disabled={!canMoveProject || movingProject}
              dataTestId="project-org-select"
            />
          </div>
          {!isGitHubSyncedProject ? (
            <ProjectPropertyFields
              project={projectProperties}
              containerRef={propertiesRef}
              availableRepos={projectProperties.linkedRepos}
              withGroupInset={false}
              showLabels={false}
            />
          ) : null}
        </PropertiesPanel>
      </WorkstationTrailSurface>
    </PropertiesRailFrame>
  );

  return {
    panel: propertiesOpen ? propertiesPanel : null,
    headerToggle: headerTrailing,
  };
}

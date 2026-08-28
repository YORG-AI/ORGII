import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type {
  LinearProjectSummary,
  LinearProjectUpdateRequest,
} from "@src/api/http/integrations";
import { FieldRow } from "@src/components/PropertyField/PropertyFieldEditable";
import {
  Calendar01Icon,
  CircleIcon,
  HugeiconsIcon,
  UserMultipleIcon,
} from "@src/icons";
import { WorkItemsOverview } from "@src/modules/ProjectManager/WorkItems/components";
import { DateQuickAssignDropdown } from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties/DateQuickAssignDropdown";
import {
  PropertiesPanel,
  PropertiesRailFrame,
} from "@src/modules/ProjectManager/shared";
import type { WorkItem } from "@src/types/core/workItem";

interface LinearProjectInfoPageProps {
  project: LinearProjectSummary;
  workItems: WorkItem[];
  saving: boolean;
  repoPath?: string | null;
  onUpdateProject: (updates: LinearProjectUpdateRequest) => Promise<void>;
}

type LinearProjectDateField = "start_date" | "target_date";

const PROJECT_UPDATE_DEBOUNCE_MS = 650;

const formatLinearProjectDate = (
  value: string | undefined,
  fallback: string
) => {
  if (!value) return fallback;
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const toLinearProjectDate = (date: Date | null) =>
  date ? date.toISOString() : null;

const LinearProjectInfoPage: React.FC<LinearProjectInfoPageProps> = ({
  project,
  workItems,
  saving,
  repoPath,
  onUpdateProject,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const projectPropsRef = useRef<HTMLElement>(null);
  const pendingProjectUpdatesRef = useRef<LinearProjectUpdateRequest>({});
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [openPicker, setOpenPicker] = useState<LinearProjectDateField | null>(
    null
  );

  const primaryTeam = project.teams[0];

  const overviewStats = useMemo(() => {
    const total = workItems.length;
    const inProgress = workItems.filter(
      (item) => item.workItemStatus === "in_progress"
    ).length;
    const completed = workItems.filter(
      (item) => item.workItemStatus === "completed"
    ).length;
    const completionRate =
      total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, inProgress, completed, completionRate };
  }, [workItems]);

  const flushProjectUpdates = useCallback(() => {
    const updates = pendingProjectUpdatesRef.current;
    pendingProjectUpdatesRef.current = {};
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
      updateTimerRef.current = null;
    }
    if (Object.keys(updates).length === 0) return;
    void onUpdateProject(updates).catch(() => undefined);
  }, [onUpdateProject]);

  const scheduleProjectUpdate = useCallback(
    (updates: LinearProjectUpdateRequest) => {
      pendingProjectUpdatesRef.current = {
        ...pendingProjectUpdatesRef.current,
        ...updates,
      };
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }
      updateTimerRef.current = setTimeout(
        flushProjectUpdates,
        PROJECT_UPDATE_DEBOUNCE_MS
      );
    },
    [flushProjectUpdates]
  );

  const flushProjectUpdatesRef = useRef(flushProjectUpdates);

  useEffect(() => {
    flushProjectUpdatesRef.current = flushProjectUpdates;
  }, [flushProjectUpdates]);

  useEffect(() => {
    return () => {
      flushProjectUpdatesRef.current();
    };
  }, []);

  const handleProjectNameChange = useCallback(
    (name: string) => {
      if (!name.trim()) return;
      scheduleProjectUpdate({ name });
    },
    [scheduleProjectUpdate]
  );

  const handleProjectDescriptionChange = useCallback(
    (_html: string, text: string) => {
      scheduleProjectUpdate({ description: text.trim() ? text : null });
    },
    [scheduleProjectUpdate]
  );

  const handleDateChange = useCallback(
    (field: LinearProjectDateField, date: Date | null) => {
      setOpenPicker(null);
      void onUpdateProject({ [field]: toLinearProjectDate(date) }).catch(
        () => undefined
      );
    },
    [onUpdateProject]
  );

  const renderDateField = (
    field: LinearProjectDateField,
    label: string,
    value: string | undefined
  ) => (
    <div className="relative flex min-h-[36px] items-center">
      <FieldRow
        icon={
          <HugeiconsIcon icon={Calendar01Icon} data-icon="calendar" size={14} />
        }
        label={label}
        value={formatLinearProjectDate(value, t("properties.addDate"))}
        isSelected={!!value}
        isActive={openPicker === field}
        usePencil
        onClick={() =>
          setOpenPicker((current) => (current === field ? null : field))
        }
      />
      {openPicker === field && (
        <DateQuickAssignDropdown
          value={value}
          onChange={(date) => handleDateChange(field, date)}
          t={t}
          fieldVariant="row"
        />
      )}
    </div>
  );

  const propertiesPanel = (
    <PropertiesRailFrame width={280} minWidth={250} maxWidth={300}>
      <PropertiesPanel
        title={t("linearProjects.statusPanel.title")}
        containerRef={projectPropsRef}
      >
        <div className="flex flex-col px-2">
          {project.status?.name && (
            <div className="relative flex min-h-[36px] items-center">
              <FieldRow
                icon={
                  <HugeiconsIcon
                    icon={CircleIcon}
                    data-icon="circle"
                    size={14}
                  />
                }
                label={t("common:common.status")}
                value={project.status.name}
                isSelected
                showChevron={false}
                onClick={() => undefined}
              />
            </div>
          )}
          {primaryTeam && (
            <div className="relative flex min-h-[36px] items-center">
              <FieldRow
                icon={
                  <HugeiconsIcon
                    icon={UserMultipleIcon}
                    data-icon="users"
                    size={14}
                  />
                }
                label={t("properties.teams")}
                value={`${primaryTeam.name} (${primaryTeam.key})`}
                isSelected
                showChevron={false}
                onClick={() => undefined}
              />
            </div>
          )}
          {renderDateField(
            "start_date",
            t("properties.startDate"),
            project.start_date
          )}
          {renderDateField(
            "target_date",
            t("properties.targetDate"),
            project.target_date
          )}
          {saving && (
            <div className="px-2 py-2 text-xs text-text-3">
              {t("common:status.saving")}
            </div>
          )}
        </div>
      </PropertiesPanel>
    </PropertiesRailFrame>
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <WorkItemsOverview
        workItems={workItems}
        projectName={project.name}
        projectDescription={project.description}
        precomputedStats={overviewStats}
        repoPath={repoPath}
        onProjectNameChange={handleProjectNameChange}
        onProjectDescriptionChange={handleProjectDescriptionChange}
        className="min-w-0 flex-1"
      />
      {propertiesPanel}
    </div>
  );
};

export default LinearProjectInfoPage;

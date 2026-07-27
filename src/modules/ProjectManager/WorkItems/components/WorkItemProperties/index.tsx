import { MoreHorizontal } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import { DEFAULT_LABELS } from "@src/modules/ProjectManager/config/manage";
import type { ContextMenuItem } from "@src/types/core/shared";
import type {
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";

import { getContextMenuItems } from "../../config";
import ScheduleEditor from "../ScheduleEditor";
import WorkItemContextMenu from "../WorkItemContextMenu";
import { DatesScheduleSection } from "./DatesScheduleSection";
import { DelegationsSection } from "./DelegationsSection";
import { LabelsSection } from "./LabelsSection";
import { PeopleSection } from "./PeopleSection";
import { PlanningSection } from "./PlanningSection";
import { StatusPrioritySection } from "./StatusPrioritySection";
import type {
  WorkItemPropertiesProps,
  WorkItemPropertyFieldKey,
  WorkItemPropertyPicker,
} from "./types";
import { useWorkItemPropertyHandlers } from "./useWorkItemPropertyHandlers";

interface PropertyCardProps {
  title: string;
  children: React.ReactNode;
}

const PropertyCard: React.FC<PropertyCardProps> = ({ title, children }) => (
  <section className="overflow-visible rounded-lg border border-solid border-border-2 bg-[var(--cm-editor-background,var(--color-bg-1))] shadow-[0_2px_6px_rgb(0_0_0_/_4%)]">
    <div className="flex h-10 items-center px-4">
      <span className="text-[13px] font-medium text-text-1">{title}</span>
    </div>
    <div className="flex w-full flex-col gap-0.5 pb-2 [&>*]:w-full">
      {children}
    </div>
  </section>
);

export const WORK_ITEM_PROPERTY_ESSENTIAL_FIELDS: WorkItemPropertyFieldKey[] = [
  "project",
  "status",
  "priority",
];

export const WORK_ITEM_PROPERTY_INLINE_FIELDS: WorkItemPropertyFieldKey[] = [
  "status",
  "priority",
];

const DEFAULT_VISIBLE_FIELDS: WorkItemPropertyFieldKey[] = [
  "project",
  "status",
  "priority",
  "assignee",
  "reviewer",
  "milestone",
  "startDate",
  "date",
  "labels",
];

const CONTEXT_MENU_FIELD_IDS: Partial<
  Record<WorkItemPropertyFieldKey, string>
> = {
  status: "status",
  priority: "priority",
  assignee: "assignee",
  project: "project",
  date: "due-date",
  labels: "labels",
};

const WorkItemProperties: React.FC<WorkItemPropertiesProps> = ({
  workItem,
  onUpdate,
  availableProjects = [],
  availableMilestones = [],
  availableLabels = DEFAULT_LABELS.map((label) => ({
    ...label,
    id: label.id,
    name: label.name,
    color: label.color,
  })),
  availableMembers = [],
  availableAgents = [],
  availableOrgs = [],
  projectIconType,
  projectReadonly = false,
  showTime = true,
  externalStatusConfig,
  fieldVariant = "row",
  pillLayout = "nowrap",
  visibleFields = DEFAULT_VISIBLE_FIELDS,
  showMoreMenu = false,
}) => {
  const { t } = useTranslation("projects");
  const [openPicker, setOpenPicker] = useState<WorkItemPropertyPicker>(null);
  const [moreMenuPosition, setMoreMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const containerRef = useRef<HTMLElement>(null);
  const visibleFieldSet = useMemo(
    () => new Set<WorkItemPropertyFieldKey>(visibleFields),
    [visibleFields]
  );

  useEffect(() => {
    setOpenPicker(null);
  }, [workItem.session_id]);

  const togglePicker = useCallback((picker: WorkItemPropertyPicker) => {
    setOpenPicker((current) => (current === picker ? null : picker));
  }, []);

  const closePicker = useCallback(() => setOpenPicker(null), []);

  useEffect(() => {
    if (openPicker === null) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("[data-field-row]")) return;
      if (target.closest("[data-property-dropdown]")) return;
      closePicker();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openPicker, closePicker]);

  const handlers = useWorkItemPropertyHandlers({
    workItem,
    onUpdate,
    availableMembers,
    availableAgents,
    availableOrgs,
    closePicker,
    t,
  });

  const handleMoreClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMoreMenuPosition({ x: rect.left, y: rect.bottom + 6 });
  }, []);

  const handleMoreContextAction = useCallback(
    (action: string, value?: string) => {
      if (action === "status" && value) {
        handlers.handleStatusChange(value as WorkItemStatus);
        return;
      }
      if (action === "priority" && value) {
        handlers.handlePriorityChange(value as WorkItemPriority);
        return;
      }
      if (action === "assignee") {
        const assignee = availableMembers.find((member) => member.id === value);
        handlers.handleAssigneeChange(
          value === "none" ? null : (assignee ?? null),
          value === "none" ? undefined : "human"
        );
        return;
      }
      if (action === "label" && value) {
        const label = availableLabels.find((item) => item.id === value);
        if (label) handlers.handleLabelToggle(label);
        return;
      }
      if (action === "project") {
        const project = availableProjects.find((item) => item.id === value);
        if (project) handlers.handleProjectChange(project);
        return;
      }
      if (action === "milestone") {
        const milestone = availableMilestones.find((item) => item.id === value);
        handlers.handleMilestoneChange(
          value === "none" ? null : (milestone ?? null)
        );
        return;
      }
      if (action === "due-date") {
        togglePicker("date");
      }
    },
    [
      availableLabels,
      availableMembers,
      availableMilestones,
      availableProjects,
      handlers,
      togglePicker,
    ]
  );

  const moreMenuItems = useMemo<ContextMenuItem[]>(() => {
    const visibleContextIds = new Set(
      visibleFields
        .map((field) => CONTEXT_MENU_FIELD_IDS[field])
        .filter((fieldId): fieldId is string => Boolean(fieldId))
    );
    const contextItems = getContextMenuItems(handleMoreContextAction, t, {
      workItem,
      availableMembers,
      availableLabels,
      availableProjects,
      availableMilestones,
    }).filter(
      (item) =>
        !item.divider &&
        item.id !== "rename" &&
        item.id !== "delete" &&
        !visibleContextIds.has(item.id)
    );

    return contextItems.flatMap((item) =>
      item.id === "more-properties" ? (item.submenu ?? []) : [item]
    );
  }, [
    availableLabels,
    availableMembers,
    availableMilestones,
    availableProjects,
    handleMoreContextAction,
    t,
    visibleFields,
    workItem,
  ]);

  if (fieldVariant === "pill") {
    return (
      <section ref={containerRef} className="min-w-0 overflow-visible">
        <div
          className={
            pillLayout === "wrap"
              ? "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5"
              : "flex min-w-0 flex-nowrap items-center gap-2"
          }
          data-testid="work-item-property-pills"
          data-layout={pillLayout}
        >
          <PlanningSection
            workItem={workItem}
            openPicker={openPicker}
            togglePicker={togglePicker}
            availableProjects={availableProjects}
            availableMilestones={availableMilestones}
            handlers={handlers}
            t={t}
            projectIconType={projectIconType}
            projectReadonly={projectReadonly}
            fieldVariant={fieldVariant}
            visibleFields={visibleFieldSet}
          />
          <StatusPrioritySection
            workItem={workItem}
            openPicker={openPicker}
            togglePicker={togglePicker}
            handlers={handlers}
            externalStatusConfig={externalStatusConfig}
            t={t}
            fieldVariant={fieldVariant}
            visibleFields={visibleFieldSet}
          />
          <PeopleSection
            workItem={workItem}
            openPicker={openPicker}
            togglePicker={togglePicker}
            availableMembers={availableMembers}
            availableAgents={availableAgents}
            availableOrgs={availableOrgs}
            handlers={handlers}
            t={t}
            fieldVariant={fieldVariant}
            visibleFields={visibleFieldSet}
          />
          <DatesScheduleSection
            workItem={workItem}
            openPicker={openPicker}
            togglePicker={togglePicker}
            handlers={handlers}
            showTime={showTime}
            t={t}
            fieldVariant={fieldVariant}
            visibleFields={visibleFieldSet}
          />
          {visibleFieldSet.has("labels") && (
            <LabelsSection
              workItem={workItem}
              openPicker={openPicker}
              togglePicker={togglePicker}
              availableLabels={availableLabels}
              handlers={handlers}
              t={t}
              fieldVariant={fieldVariant}
            />
          )}
          {showMoreMenu && moreMenuItems.length > 0 && (
            <Button
              variant="secondary"
              size="small"
              shape="circle"
              iconOnly
              icon={<MoreHorizontal size={DROPDOWN_ITEM.iconSize} />}
              onClick={handleMoreClick}
              aria-label={t("workItems.contextMenu.moreProperties")}
              className="!h-7 !w-7 !min-w-7 !rounded-full !border !border-solid !border-border-2 !bg-bg-2 !p-0 !text-text-2 !shadow-none hover:!bg-surface-hover"
            />
          )}
        </div>
        {moreMenuPosition && (
          <WorkItemContextMenu
            items={moreMenuItems}
            position={moreMenuPosition}
            onClose={() => setMoreMenuPosition(null)}
          />
        )}
      </section>
    );
  }

  return (
    <section
      ref={containerRef}
      className="flex h-full flex-col overflow-hidden p-2"
    >
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
        <div className="flex flex-col gap-2 pb-2">
          <PropertyCard title={t("workItems.properties.propertiesSection")}>
            <PlanningSection
              workItem={workItem}
              openPicker={openPicker}
              togglePicker={togglePicker}
              availableProjects={availableProjects}
              availableMilestones={availableMilestones}
              handlers={handlers}
              t={t}
              projectIconType={projectIconType}
              projectReadonly={projectReadonly}
              visibleFields={visibleFieldSet}
            />
            <StatusPrioritySection
              workItem={workItem}
              openPicker={openPicker}
              togglePicker={togglePicker}
              handlers={handlers}
              externalStatusConfig={externalStatusConfig}
              t={t}
            />
            <DatesScheduleSection
              workItem={workItem}
              openPicker={openPicker}
              togglePicker={togglePicker}
              handlers={handlers}
              showTime={showTime}
              t={t}
            />
            <LabelsSection
              workItem={workItem}
              openPicker={openPicker}
              togglePicker={togglePicker}
              availableLabels={availableLabels}
              handlers={handlers}
              t={t}
            />
            <DelegationsSection workItem={workItem} t={t} />
          </PropertyCard>
          <PropertyCard title={t("workItems.properties.assignment")}>
            <PeopleSection
              workItem={workItem}
              openPicker={openPicker}
              togglePicker={togglePicker}
              availableMembers={availableMembers}
              availableAgents={availableAgents}
              availableOrgs={availableOrgs}
              handlers={handlers}
              t={t}
            />
            <div className="mx-4 my-2 h-px bg-border-1" />
            <ScheduleEditor
              schedule={workItem.schedule}
              onChange={handlers.handleScheduleChange}
              t={t}
            />
          </PropertyCard>
        </div>
      </div>
    </section>
  );
};

export default WorkItemProperties;

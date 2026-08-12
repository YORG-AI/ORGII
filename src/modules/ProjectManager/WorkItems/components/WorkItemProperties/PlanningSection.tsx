import { BookDashed, BookOpen, Diamond } from "lucide-react";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { PropertyDropdownField } from "@src/components/PropertyField/PropertyDropdownField";
import {
  FieldRow,
  type FieldRowVariant,
  Option,
  SearchableDropdown,
} from "@src/components/PropertyField/PropertyFieldEditable";
import type {
  WorkItem as WorkItemExtended,
  WorkItemMilestone,
  WorkItemProject,
} from "@src/types/core/workItem";

import type {
  WorkItemPropertyFieldKey,
  WorkItemPropertyHandlers,
  WorkItemPropertyPicker,
  WorkItemPropertyTranslator,
} from "./types";

interface PlanningSectionProps {
  workItem: WorkItemExtended;
  openPicker: WorkItemPropertyPicker;
  togglePicker: (picker: WorkItemPropertyPicker) => void;
  availableProjects: WorkItemProject[];
  availableMilestones: WorkItemMilestone[];
  handlers: WorkItemPropertyHandlers;
  t: WorkItemPropertyTranslator;
  projectIconType?: string;
  projectReadonly?: boolean;
  fieldVariant?: FieldRowVariant;
  visibleFields?: Set<WorkItemPropertyFieldKey>;
}

export function PlanningSection({
  workItem,
  openPicker,
  togglePicker,
  availableProjects,
  availableMilestones,
  handlers,
  t,
  projectIconType,
  projectReadonly = false,
  fieldVariant = "row",
  visibleFields,
}: PlanningSectionProps) {
  const showProject = !visibleFields || visibleFields.has("project");
  const showMilestone = !visibleFields || visibleFields.has("milestone");
  if (!showProject && !showMilestone) return null;

  return (
    <>
      {showProject && (
        <PropertyDropdownField
          value={workItem.project?.id ?? "__none__"}
          label={workItem.project?.name ?? t("workItems.properties.noProject")}
          icon={
            workItem.project ? (
              projectIconType ? (
                <IntegrationIcon
                  type={projectIconType}
                  size={DROPDOWN_ITEM.iconSize}
                />
              ) : (
                <BookOpen size={DROPDOWN_ITEM.iconSize} />
              )
            ) : (
              <BookDashed size={DROPDOWN_ITEM.iconSize} />
            )
          }
          iconColor={workItem.project?.color}
          options={[]}
          placement="portal"
          fieldVariant={fieldVariant}
          triggerVariant={fieldVariant}
          searchable
          searchPlaceholder={t("common:actions.search")}
          selected={!!workItem.project}
          readonly={projectReadonly}
          active={openPicker === "project"}
          onActiveChange={(active) => togglePicker(active ? "project" : null)}
          onClear={() => handlers.handleProjectChange(null)}
          renderOptions={(searchQuery, close) => {
            const filtered = searchQuery
              ? availableProjects.filter((project) =>
                  project.name.toLowerCase().includes(searchQuery.toLowerCase())
                )
              : availableProjects;
            const select = (project: WorkItemProject | null) => {
              handlers.handleProjectChange(project);
              close();
            };
            return (
              <>
                {!searchQuery && (
                  <Option
                    icon={<BookDashed size={DROPDOWN_ITEM.iconSize} />}
                    label={t("workItems.properties.noProject")}
                    isSelected={!workItem.project}
                    onClick={() => select(null)}
                  />
                )}
                {filtered.length === 0 && searchQuery && (
                  <div className={DROPDOWN_CLASSES.listMessage}>
                    {t("common:common.noResults")}
                  </div>
                )}
                {filtered.map((projectItem) => (
                  <Option
                    key={projectItem.id}
                    icon={
                      projectIconType &&
                      projectItem.id === workItem.project?.id ? (
                        <IntegrationIcon
                          type={projectIconType}
                          size={DROPDOWN_ITEM.iconSize}
                        />
                      ) : (
                        <BookOpen size={DROPDOWN_ITEM.iconSize} />
                      )
                    }
                    iconColor={projectItem.color}
                    label={projectItem.name}
                    isSelected={workItem.project?.id === projectItem.id}
                    onClick={() => select(projectItem)}
                  />
                ))}
              </>
            );
          }}
        />
      )}

      {showMilestone && (
        <div
          className={
            fieldVariant === "pill"
              ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
              : "relative flex min-h-8 w-full items-center"
          }
        >
          <FieldRow
            icon={<Diamond size={DROPDOWN_ITEM.iconSize} />}
            value={
              workItem.milestone?.name || t("workItems.properties.noMilestone")
            }
            isSelected={!!workItem.milestone}
            isActive={openPicker === "milestone"}
            showChevron
            variant={fieldVariant}
            onClear={() => handlers.handleMilestoneChange(null)}
            onClick={() => togglePicker("milestone")}
          />
          {openPicker === "milestone" && (
            <SearchableDropdown
              placeholder={t("common:actions.search")}
              widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
              align={fieldVariant === "pill" ? "auto" : "left"}
            >
              {(searchQuery) => {
                const filtered = searchQuery
                  ? availableMilestones.filter((milestone) =>
                      milestone.name
                        .toLowerCase()
                        .includes(searchQuery.toLowerCase())
                    )
                  : availableMilestones;
                return (
                  <>
                    {!searchQuery && (
                      <Option
                        label={t("workItems.properties.noMilestone")}
                        onClick={() => handlers.handleMilestoneChange(null)}
                      />
                    )}
                    {filtered.map((milestone) => (
                      <Option
                        key={milestone.id}
                        icon={<Diamond size={DROPDOWN_ITEM.iconSize} />}
                        label={milestone.name}
                        isSelected={workItem.milestone?.id === milestone.id}
                        onClick={() =>
                          handlers.handleMilestoneChange(milestone)
                        }
                      />
                    ))}
                  </>
                );
              }}
            </SearchableDropdown>
          )}
        </div>
      )}
    </>
  );
}

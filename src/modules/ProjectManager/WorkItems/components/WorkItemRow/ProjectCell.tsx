import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import { PropertyDropdownField } from "@src/components/PropertyField/PropertyDropdownField";
import { Option } from "@src/components/PropertyField/PropertyFieldEditable";
import { Book02Icon, DeliveryBox01Icon, HugeiconsIcon } from "@src/icons";
import type { WorkItemProject } from "@src/types/core/workItem";

interface ProjectCellProps {
  project?: WorkItemProject;
  availableProjects: WorkItemProject[];
  /** Receives the chosen project, or `null` to clear the project. */
  onProjectSelect?: (project: WorkItemProject | null) => void;
  readonly?: boolean;
  t: (key: string) => string;
}

export function ProjectCell({
  project,
  availableProjects,
  onProjectSelect,
  readonly = false,
  t,
}: ProjectCellProps) {
  const label = project?.name ?? t("workItems.properties.noProject");
  const canEdit = !readonly && !!onProjectSelect;

  return (
    <PropertyDropdownField
      value={project?.id ?? "__none__"}
      label={label}
      icon={
        project ? (
          <HugeiconsIcon
            icon={DeliveryBox01Icon}
            data-icon="box"
            size={DROPDOWN_ITEM.iconSize}
          />
        ) : (
          <HugeiconsIcon
            icon={Book02Icon}
            data-icon="book-dashed"
            size={DROPDOWN_ITEM.iconSize}
          />
        )
      }
      iconColor={project?.color}
      options={[]}
      placement="portal"
      fieldVariant="pill"
      triggerVariant="pill"
      readonly={!canEdit}
      searchable
      searchPlaceholder={t("workItems.properties.searchProjects")}
      selected={!!project}
      maxWidthClassName="max-w-[220px]"
      valueClassName="text-xs font-medium tabular-nums text-text-3"
      borderless
      renderOptions={(searchQuery, close) => {
        const filtered = searchQuery
          ? availableProjects.filter((projectItem) =>
              projectItem.name.toLowerCase().includes(searchQuery.toLowerCase())
            )
          : availableProjects;
        const select = (nextProject: WorkItemProject | null) => {
          onProjectSelect?.(nextProject);
          close();
        };
        return (
          <>
            {!searchQuery && (
              <Option
                label={t("workItems.properties.noProject")}
                icon={
                  <HugeiconsIcon
                    icon={Book02Icon}
                    data-icon="book-dashed"
                    size={DROPDOWN_ITEM.iconSize}
                  />
                }
                isSelected={!project}
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
                  <HugeiconsIcon
                    icon={DeliveryBox01Icon}
                    data-icon="box"
                    size={DROPDOWN_ITEM.iconSize}
                  />
                }
                iconColor={projectItem.color}
                label={projectItem.name}
                isSelected={project?.id === projectItem.id}
                onClick={() => select(projectItem)}
              />
            ))}
          </>
        );
      }}
    />
  );
}

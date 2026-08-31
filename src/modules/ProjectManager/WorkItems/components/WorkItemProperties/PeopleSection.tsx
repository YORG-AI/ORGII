import type { FieldRowVariant } from "@src/components/PropertyField/PropertyFieldEditable";
import type { Person } from "@src/types/core/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import { AssigneePropertyField } from "./AssigneePropertyField";
import type {
  WorkItemExternalAssigneeConfig,
  WorkItemPropertyFieldKey,
  WorkItemPropertyHandlers,
  WorkItemPropertyPicker,
  WorkItemPropertyTranslator,
} from "./types";

interface PeopleSectionProps {
  workItem: WorkItemExtended;
  openPicker: WorkItemPropertyPicker;
  togglePicker: (picker: WorkItemPropertyPicker) => void;
  availableMembers: Person[];
  handlers: WorkItemPropertyHandlers;
  t: WorkItemPropertyTranslator;
  fieldVariant?: FieldRowVariant;
  visibleFields?: Set<WorkItemPropertyFieldKey>;
  assigneeReadonly?: boolean;
  externalAssigneeConfig?: WorkItemExternalAssigneeConfig;
}

export function PeopleSection({
  workItem,
  openPicker,
  togglePicker,
  availableMembers,
  handlers,
  t,
  fieldVariant = "row",
  visibleFields,
  assigneeReadonly = false,
  externalAssigneeConfig,
}: PeopleSectionProps) {
  const showAssignee = !visibleFields || visibleFields.has("assignee");
  if (!showAssignee) return null;

  return (
    <>
      {showAssignee && (
        <AssigneePropertyField
          workItem={workItem}
          availableMembers={availableMembers}
          onAssigneeChange={handlers.handleAssigneeChange}
          t={t}
          fieldVariant={fieldVariant}
          placement="portal"
          active={openPicker === "assignee"}
          onActiveChange={(active) => togglePicker(active ? "assignee" : null)}
          readonly={assigneeReadonly}
          externalConfig={externalAssigneeConfig}
        />
      )}
    </>
  );
}

import { ScanEye } from "lucide-react";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  FieldRow,
  type FieldRowVariant,
} from "@src/components/PropertyField/PropertyFieldEditable";
import type {
  AgentDefinition,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";
import type { Person } from "@src/types/core/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import { AssigneePropertyField } from "./AssigneePropertyField";
import { ReviewerDropdown } from "./ReviewerDropdown";
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
  availableAgents: AgentDefinition[];
  availableOrgs: OrgMember[];
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
  availableAgents,
  availableOrgs,
  handlers,
  t,
  fieldVariant = "row",
  visibleFields,
  assigneeReadonly = false,
  externalAssigneeConfig,
}: PeopleSectionProps) {
  const showAssignee = !visibleFields || visibleFields.has("assignee");
  const showReviewer = !visibleFields || visibleFields.has("reviewer");
  if (!showAssignee && !showReviewer) return null;

  return (
    <>
      {showAssignee && (
        <AssigneePropertyField
          workItem={workItem}
          availableMembers={availableMembers}
          availableAgents={availableAgents}
          availableOrgs={availableOrgs}
          allAgentList={handlers.allAgentList}
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

      {showReviewer && (
        <div
          className={
            fieldVariant === "pill"
              ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
              : "relative flex min-h-8 w-full items-center"
          }
        >
          <FieldRow
            icon={<ScanEye size={DROPDOWN_ITEM.iconSize} />}
            value={handlers.getReviewerDisplay()}
            isSelected={!!handlers.currentReviewer}
            isActive={openPicker === "reviewer"}
            variant={fieldVariant}
            onClear={() => handlers.handleReviewerChange(null)}
            onClick={() => togglePicker("reviewer")}
          />
          {openPicker === "reviewer" && (
            <ReviewerDropdown
              allAgentList={handlers.allAgentList}
              availableMembers={availableMembers}
              currentReviewer={
                handlers.currentReviewer as
                  | { type?: string; id?: string }
                  | undefined
              }
              onReviewerChange={handlers.handleReviewerChange}
              t={t}
              fieldVariant={fieldVariant}
            />
          )}
        </div>
      )}
    </>
  );
}

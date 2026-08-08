import type { ChangeEvent } from "react";

import type { DropdownOption, Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemPriority,
  WorkItemProject,
  WorkItemStatus,
} from "@src/types/core/workItem";

export interface WorkItemRowProps {
  workItem: WorkItemExtended;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onUpdate?: (id: string, updates: Partial<WorkItemExtended>) => void;
  onDelete?: (id: string) => void;
  onRestore?: (id: string) => void;
  readonly?: boolean;
  compact?: boolean;
  variant?: "card" | "table";
  availableMembers?: Person[];
  availableProjects?: WorkItemProject[];
  availableMilestones?: WorkItemMilestone[];
  availableLabels?: WorkItemLabel[];
  isChecked?: boolean;
  onCheckedChange?: (id: string, checked: boolean) => void;
  workItemPrefix?: string;
  showCheckboxes?: boolean;
  externalStatusValue?: string;
  externalStatusOptions?: DropdownOption<string>[];
  onExternalStatusChange?: (statusId: string) => void | Promise<void>;
  statusDisabled?: boolean;
  /**
   * Render the project cell as read-only even when the row itself is
   * editable. Used by the cross-project Work Items page where moving an
   * item between projects is not yet supported.
   */
  disableProjectEdit?: boolean;
  /** Hide redundant project identity in a fixed project-scoped list. */
  hideProjectCell?: boolean;
}

export interface DueDateInfo {
  formatted: string;
  colorClass: string;
}

export interface LeadingCellsProps {
  shortId: string;
  priority: WorkItemPriority;
  status: WorkItemStatus;
  isChecked: boolean;
  showCheckboxes: boolean;
  onCheckboxChange: (
    checked: boolean,
    event: ChangeEvent<HTMLInputElement>
  ) => void;
  onPriorityChange?: (newPriority: WorkItemPriority) => void;
  onStatusChange?: (newStatus: WorkItemStatus) => void;
  externalStatusValue?: string;
  externalStatusOptions?: DropdownOption<string>[];
  onExternalStatusChange?: (statusId: string) => void | Promise<void>;
  statusDisabled?: boolean;
  readonly?: boolean;
}

export interface AssigneeCellProps {
  workItem: WorkItemExtended;
  availableMembers: Person[];
  onAssigneeSelect?: (person: Person | null) => void;
  readonly?: boolean;
  t: (key: string) => string;
}

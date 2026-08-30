import type { WorkItemSchedule } from "@src/api/http/project";
import type { FieldRowVariant } from "@src/components/PropertyField/PropertyFieldEditable";
import type { Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemPriority,
  WorkItemProject,
  WorkItemStatus,
} from "@src/types/core/workItem";

export type WorkItemPropertyPicker =
  | "status"
  | "priority"
  | "assignee"
  | "project"
  | "milestone"
  | "startDate"
  | "date"
  | "labels"
  | null;

export type WorkItemPropertyFieldKey = Exclude<WorkItemPropertyPicker, null>;

export type WorkItemPropertyTranslator = (
  key: string,
  options?: Record<string, unknown>
) => string;

export interface WorkItemExternalStatusOption {
  id: string;
  label: string;
  color?: string;
}

export interface WorkItemExternalStatusConfig {
  currentStatusId?: string;
  options: WorkItemExternalStatusOption[];
  loading?: boolean;
  disabled?: boolean;
  onChangeStatusId: (statusId: string) => void | Promise<void>;
}

export interface WorkItemExternalAssigneeOption {
  id: string;
  label: string;
  avatar?: string;
}

export interface WorkItemExternalAssigneeConfig {
  currentAssigneeIds: string[];
  options: WorkItemExternalAssigneeOption[];
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  readonlyReason?: string;
  onOpen?: () => void | Promise<void>;
  onChangeAssigneeIds: (assigneeIds: string[]) => void | Promise<void>;
}

export interface WorkItemPropertiesProps {
  workItem: WorkItemExtended;
  onUpdate: (updates: Partial<WorkItemExtended>) => void;
  externalStatusConfig?: WorkItemExternalStatusConfig;
  externalAssigneeConfig?: WorkItemExternalAssigneeConfig;
  availableProjects?: WorkItemProject[];
  availableMilestones?: WorkItemMilestone[];
  availableLabels?: WorkItemLabel[];
  availableMembers?: Person[];
  /** Brand integration icon for the selected project (for example, GitHub). */
  projectIconType?: string;
  /** Show the current project without allowing it to be changed or cleared. */
  projectReadonly?: boolean;
  /** Show the current assignee without offering a local-only picker. */
  assigneeReadonly?: boolean;
  /** Show the labels a remote source owns without offering a local picker. */
  labelsReadonly?: boolean;
  showTime?: boolean;
  fieldVariant?: FieldRowVariant;
  /**
   * Layout policy for pill fields. Inline create surfaces keep the compact
   * single-row strip; constrained detail threads can opt into wrapping.
   */
  pillLayout?: "nowrap" | "wrap";
  visibleFields?: WorkItemPropertyFieldKey[];
  showMoreMenu?: boolean;
  /**
   * Offer the recurring/one-shot schedule editor. Remote sources that cannot
   * persist a schedule (for example GitHub issues) pass false so the panel
   * never shows a control whose changes would be dropped.
   */
  showSchedule?: boolean;
  /** Row panels can use legacy cards or the shared Workstation trail layout. */
  panelVariant?: "cards" | "workstation-trail";
}

export interface WorkItemPropertyHandlers {
  handleStatusChange: (value: WorkItemStatus) => void;
  handlePriorityChange: (value: WorkItemPriority) => void;
  handleAssigneeChange: (person: Person | null) => void;
  handleScheduleChange: (schedule: WorkItemSchedule | null) => void;
  handleLabelToggle: (label: WorkItemLabel) => void;
  handleLabelsClear: () => void;
  handleProjectChange: (project: WorkItemProject | null) => void;
  handleMilestoneChange: (milestone: WorkItemMilestone | null) => void;
  handleStartDateChange: (date: Date | null) => void;
  handleDateChange: (date: Date | null) => void;
  formatStartDate: (date: string | undefined) => string;
  formatDueDate: (date: string | undefined) => string;
  getRelativeTime: (date: string | undefined) => string;
}

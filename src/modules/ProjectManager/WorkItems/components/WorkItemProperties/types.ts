import type { ReviewerRefType, WorkItemSchedule } from "@src/api/http/project";
import type { FieldRowVariant } from "@src/components/PropertyField/PropertyFieldEditable";
import type {
  AgentDefinition,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";
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
  | "reviewer"
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

export interface WorkItemPropertiesProps {
  workItem: WorkItemExtended;
  onUpdate: (updates: Partial<WorkItemExtended>) => void;
  externalStatusConfig?: WorkItemExternalStatusConfig;
  availableProjects?: WorkItemProject[];
  availableMilestones?: WorkItemMilestone[];
  availableLabels?: WorkItemLabel[];
  availableMembers?: Person[];
  availableAgents?: AgentDefinition[];
  availableOrgs?: OrgMember[];
  /** Brand integration icon for the selected project (for example, GitHub). */
  projectIconType?: string;
  /** Show the current project without allowing it to be changed or cleared. */
  projectReadonly?: boolean;
  showTime?: boolean;
  fieldVariant?: FieldRowVariant;
  visibleFields?: WorkItemPropertyFieldKey[];
  showMoreMenu?: boolean;
}

export interface WorkItemPropertyHandlers {
  allAgentList: { id: string; name: string }[];
  currentReviewer: unknown;
  handleStatusChange: (value: WorkItemStatus) => void;
  handlePriorityChange: (value: WorkItemPriority) => void;
  handleAssigneeChange: (person: Person | null, assigneeType?: string) => void;
  handleReviewerChange: (
    reviewerType: ReviewerRefType | null,
    reviewerId?: string
  ) => void;
  getReviewerDisplay: () => string;
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

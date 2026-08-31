import {
  AlertCircleIcon,
  BanIcon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  Edit04Icon,
  type IconSvgElement,
  Loading03Icon,
  Wrench01Icon,
} from "@src/icons";

export interface SessionFileChange {
  path: string;
  tool: string;
  count: number;
}

export interface AgentMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_input: string | null;
  tool_output: string | null;
  model: string | null;
  sequence: number;
  created_at: string;
}

export type SessionFilesCache = Map<string, SessionFileChange[]>;

export interface SessionRun {
  effectiveId: string;
  role: string;
  runNumber: number;
  status: string;
  isActive: boolean;
  session_id: string;
}

export interface StatusStyle {
  icon: IconSvgElement;
  iconClass: string;
  badgeClass: string;
}

export const STATUS_STYLES: Record<string, StatusStyle> = {
  running: {
    icon: Loading03Icon,
    iconClass: "text-primary-6 animate-spin",
    badgeClass: "bg-primary-1 text-primary-6",
  },
  completed: {
    icon: CheckmarkCircle01Icon,
    iconClass: "text-success-6",
    badgeClass: "bg-success-1 text-success-6",
  },
  failed: {
    icon: CancelCircleIcon,
    iconClass: "text-danger-6",
    badgeClass: "bg-danger-1 text-danger-6",
  },
  error: {
    icon: AlertCircleIcon,
    iconClass: "text-danger-6",
    badgeClass: "bg-danger-1 text-danger-6",
  },
  cancelled: {
    icon: BanIcon,
    iconClass: "text-text-4",
    badgeClass: "bg-fill-2 text-text-3",
  },
};

const DEFAULT_STATUS_STYLE: StatusStyle = {
  icon: Loading03Icon,
  iconClass: "text-text-4",
  badgeClass: "bg-fill-2 text-text-3",
};

export function getStatusStyle(status: string): StatusStyle {
  return STATUS_STYLES[status] ?? DEFAULT_STATUS_STYLE;
}

export const TERMINAL_STATUS = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
]);

export const STATUS_I18N_KEYS: Record<string, string> = {
  running: "workItems.agentWorkflow.statusRunning",
  completed: "workItems.agentWorkflow.statusCompleted",
  failed: "workItems.agentWorkflow.statusFailed",
  error: "workItems.agentWorkflow.statusFailed",
  cancelled: "workItems.agentWorkflow.statusCancelled",
};

export const TOOL_LABEL_I18N_KEYS: Record<string, string> = {
  edit_file: "workItems.toolLabels.edit",
  apply_patch: "workItems.toolLabels.patch",
};

export const TOOL_ICONS: Record<string, IconSvgElement> = {
  edit_file: Edit04Icon,
  apply_patch: Wrench01Icon,
};

import {
  TERMINAL_AGENT_STATUS,
  type TerminalAgentActivity,
  type TerminalAgentStatus,
} from "@src/engines/TerminalCore/types";

export interface TerminalAgentStatusPresentation {
  dotClass: string;
  iconClass: string;
  labelKey: string;
  defaultLabel: string;
}

export const TERMINAL_AGENT_STATUS_PRESENTATION: Record<
  TerminalAgentStatus,
  TerminalAgentStatusPresentation
> = {
  [TERMINAL_AGENT_STATUS.STARTING]: {
    dotClass: "bg-warning-6",
    iconClass: "text-warning-6",
    labelKey: "chat.terminalAgent.status.starting",
    defaultLabel: "Starting",
  },
  [TERMINAL_AGENT_STATUS.RUNNING]: {
    dotClass: "bg-success-6",
    iconClass: "text-success-6",
    labelKey: "chat.terminalAgent.status.running",
    defaultLabel: "Running",
  },
  [TERMINAL_AGENT_STATUS.WAITING]: {
    dotClass: "bg-warning-6",
    iconClass: "text-warning-6",
    labelKey: "chat.terminalAgent.status.waiting",
    defaultLabel: "Waiting for input",
  },
  [TERMINAL_AGENT_STATUS.BLOCKED]: {
    dotClass: "bg-danger-6",
    iconClass: "text-danger-6",
    labelKey: "chat.terminalAgent.status.blocked",
    defaultLabel: "Approval required",
  },
  [TERMINAL_AGENT_STATUS.DONE]: {
    dotClass: "bg-fill-4",
    iconClass: "text-text-3",
    labelKey: "chat.terminalAgent.status.done",
    defaultLabel: "Done",
  },
};

export function shouldNotifyHermesApproval(
  previousStatus: TerminalAgentStatus | undefined,
  nextStatus: TerminalAgentStatus,
  isBackground: boolean
): boolean {
  return (
    nextStatus === TERMINAL_AGENT_STATUS.BLOCKED &&
    previousStatus !== TERMINAL_AGENT_STATUS.BLOCKED &&
    isBackground
  );
}

export function isHermesTerminalBackground(
  terminalVisible: boolean,
  documentHidden: boolean,
  windowHasFocus: boolean
): boolean {
  return !terminalVisible || documentHidden || !windowHasFocus;
}

export function isExternalHermesNotificationOwner(
  windowLabel: string
): boolean {
  return windowLabel === "main";
}

export function getHermesApprovalNotificationBody(
  activity: Pick<TerminalAgentActivity, "toolInputPreview" | "toolName">
): string {
  return (
    activity.toolInputPreview ||
    (activity.toolName ? `${activity.toolName} needs approval` : null) ||
    "Hermes is waiting for approval"
  );
}

export function isHermesApprovalNotificationFor(
  extra: Record<string, unknown> | undefined,
  tabId: string,
  terminalSessionId: string
): boolean {
  return (
    extra?.kind === "hermes-approval" &&
    extra.tabId === tabId &&
    extra.terminalSessionId === terminalSessionId
  );
}

export function formatTerminalAgentDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round(
    (durationMs % 60_000) / 1_000
  )}s`;
}

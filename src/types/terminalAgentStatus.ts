/** Canonical terminal-agent lifecycle values used by the wire protocol and UI. */
export const TERMINAL_AGENT_STATUS = {
  STARTING: "starting",
  RUNNING: "running",
  WAITING: "waiting",
  BLOCKED: "blocked",
  DONE: "done",
} as const;

export type TerminalAgentStatus =
  (typeof TERMINAL_AGENT_STATUS)[keyof typeof TERMINAL_AGENT_STATUS];

export const TERMINAL_AGENT_STATUS_VALUES = Object.values(
  TERMINAL_AGENT_STATUS
) as [TerminalAgentStatus, ...TerminalAgentStatus[]];

const TERMINAL_AGENT_STATUS_SET = new Set<string>(TERMINAL_AGENT_STATUS_VALUES);

export function isTerminalAgentStatus(
  value: unknown
): value is TerminalAgentStatus {
  return typeof value === "string" && TERMINAL_AGENT_STATUS_SET.has(value);
}

import { describe, expect, it } from "vitest";

import {
  AGENT_ORG_TASK_STATUS,
  agentOrgTaskStatusSatisfiesDependency,
  isAgentOrgTaskOpenStatus,
  isAgentOrgTaskTerminalStatus,
} from "../orgTasks";

describe("Agent Org Task status semantics", () => {
  it.each([
    [AGENT_ORG_TASK_STATUS.PENDING, true, false, false],
    [AGENT_ORG_TASK_STATUS.IN_PROGRESS, true, false, false],
    [AGENT_ORG_TASK_STATUS.COMPLETED, false, true, true],
    [AGENT_ORG_TASK_STATUS.FAILED, false, true, false],
    [AGENT_ORG_TASK_STATUS.CANCELLED, false, true, false],
  ] as const)(
    "keeps open, terminal, and dependency semantics distinct for %s",
    (status, open, terminal, satisfiesDependency) => {
      expect(isAgentOrgTaskOpenStatus(status)).toBe(open);
      expect(isAgentOrgTaskTerminalStatus(status)).toBe(terminal);
      expect(agentOrgTaskStatusSatisfiesDependency(status)).toBe(
        satisfiesDependency
      );
    }
  );
});

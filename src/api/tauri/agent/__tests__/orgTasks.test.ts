import { afterEach, describe, expect, it, vi } from "vitest";

import { invokeTauri } from "@src/util/platform/tauri/init";

import {
  AGENT_ORG_TASK_STATUS,
  agentOrgTaskStatusSatisfiesDependency,
  isAgentOrgTaskOpenStatus,
  isAgentOrgTaskTerminalStatus,
  pauseAgentOrgRun,
  resumeAgentOrgRun,
  subscribeAgentOrgStateChanges,
} from "../orgTasks";

vi.mock("@src/util/platform/tauri/init", () => ({ invokeTauri: vi.fn() }));

const invokeMock = vi.mocked(invokeTauri);

afterEach(() => {
  invokeMock.mockReset();
});

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

describe("Agent Org durable Pause/Resume wire", () => {
  it("sends the caller-stable Pause request id and returns the structured receipt", async () => {
    const outcome = {
      requestId: "00000000-0000-4000-8000-000000000101",
      runId: "run-a",
      episodeId: "episode-a",
      transitioned: true,
      pauseGeneration: 2,
      capturedTurnCount: 10,
      drainingTurnCount: 10,
      timedOutTurnCount: 0,
    };
    invokeMock.mockResolvedValueOnce(outcome);
    const changes: string[] = [];
    const unsubscribe = subscribeAgentOrgStateChanges((sessionId) =>
      changes.push(sessionId)
    );

    await expect(
      pauseAgentOrgRun("root-session", outcome.requestId)
    ).resolves.toEqual(outcome);
    expect(invokeMock).toHaveBeenCalledWith("agent_org_pause_run", {
      sessionId: "root-session",
      requestId: outcome.requestId,
    });
    expect(changes).toEqual(["root-session"]);
    unsubscribe();
  });

  it("sends the caller-stable Resume request id and exposes continuation counts", async () => {
    const outcome = {
      requestId: "00000000-0000-4000-8000-000000000102",
      runId: "run-a",
      episodeId: "episode-a",
      transitioned: true,
      resumeGeneration: 3,
      continuationCount: 7,
      skippedCount: 3,
    };
    invokeMock.mockResolvedValueOnce(outcome);

    await expect(
      resumeAgentOrgRun("root-session", outcome.requestId)
    ).resolves.toEqual(outcome);
    expect(invokeMock).toHaveBeenCalledWith("agent_org_resume_run", {
      sessionId: "root-session",
      requestId: outcome.requestId,
    });
  });
});

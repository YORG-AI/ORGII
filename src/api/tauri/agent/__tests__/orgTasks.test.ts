import { afterEach, describe, expect, it, vi } from "vitest";

import { invokeTauri } from "@src/util/platform/tauri/init";

import {
  AGENT_ORG_TASK_STATUS,
  agentOrgTaskStatusSatisfiesDependency,
  getAgentOrgGroupProjectionPage,
  isAgentOrgTaskOpenStatus,
  isAgentOrgTaskTerminalStatus,
  pauseAgentOrgRun,
  resumeAgentOrgRun,
  retryAgentOrgGroupDelivery,
  sendAgentOrgGroupRootMessage,
  stopAgentOrgGroupDelivery,
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

describe("Agent Org bounded Group projection wire", () => {
  it("uses one canonical page command with explicit bounded defaults", async () => {
    const page = {
      runId: "run-a",
      items: [],
      hasMore: false,
    };
    invokeMock.mockResolvedValueOnce(page);

    await expect(
      getAgentOrgGroupProjectionPage({ sessionId: "member-or-root" })
    ).resolves.toEqual(page);
    expect(invokeMock).toHaveBeenCalledWith("agent_org_group_projection_page", {
      sessionId: "member-or-root",
      cursor: null,
      limit: 50,
    });
  });

  it("submits GroupRoot through the typed Root command and invalidates the shared run view", async () => {
    const response = {
      turnIntentId: "turn-root",
      targetMemberId: "coordinator",
      targetName: "Coordinator",
    };
    invokeMock.mockResolvedValueOnce(response);
    const changes: string[] = [];
    const unsubscribe = subscribeAgentOrgStateChanges((sessionId) =>
      changes.push(sessionId)
    );

    await expect(
      sendAgentOrgGroupRootMessage({
        sessionId: "root-session",
        turnIntentId: "turn-root",
        clientMessageId: "client-root",
        content: "Ask Coordinator",
      })
    ).resolves.toEqual(response);
    expect(invokeMock).toHaveBeenCalledWith(
      "agent_org_send_group_root_message",
      {
        sessionId: "root-session",
        turnIntentId: "turn-root",
        clientMessageId: "client-root",
        content: "Ask Coordinator",
        displayText: null,
        images: null,
      }
    );
    expect(changes).toEqual(["root-session"]);
    unsubscribe();
  });

  it("sends Stop and confirmed new-Turn Retry with exact Turn identities", async () => {
    invokeMock
      .mockResolvedValueOnce({
        turnIntentId: "turn-member",
        outcome: "queued_cancelled",
      })
      .mockResolvedValueOnce({
        sourceTurnIntentId: "turn-member",
        turnIntentId: "turn-member-retry",
        outcome: "created",
      });

    await stopAgentOrgGroupDelivery({
      sessionId: "root-session",
      turnIntentId: "turn-member",
    });
    await retryAgentOrgGroupDelivery({
      sessionId: "root-session",
      sourceTurnIntentId: "turn-member",
      retryTurnIntentId: "turn-member-retry",
      acknowledgePossibleDuplicate: true,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "agent_org_stop_group_delivery",
      {
        sessionId: "root-session",
        turnIntentId: "turn-member",
      }
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "agent_org_retry_group_delivery",
      {
        sessionId: "root-session",
        sourceTurnIntentId: "turn-member",
        retryTurnIntentId: "turn-member-retry",
        acknowledgePossibleDuplicate: true,
      }
    );
  });
});

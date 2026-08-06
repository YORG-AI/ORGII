import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionLaunchResult } from "@src/api/tauri/agent/session";

import { SessionService } from "./SessionService";

const mocks = vi.hoisted(() => ({
  sessionLaunch: vi.fn(),
  registerCreatedSession: vi.fn(),
}));

vi.mock("@src/api/tauri/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/tauri/agent")>()),
  sessionLaunch: mocks.sessionLaunch,
}));

vi.mock("@src/store/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/store/session")>()),
  registerCreatedSession: mocks.registerCreatedSession,
}));

vi.mock("@src/services/context/collectors", () => ({
  collectAdeContext: () => undefined,
}));

function launchResult(
  overrides: Partial<SessionLaunchResult> = {}
): SessionLaunchResult {
  return {
    sessionId: "sdeagent-service-created",
    category: "rust_agent",
    name: "Service-created session",
    status: "running",
    createdAt: "2026-08-05T12:00:00.000Z",
    userInput: "Do the work",
    background: false,
    ...overrides,
  };
}

describe("SessionService.create", () => {
  beforeEach(() => {
    mocks.sessionLaunch.mockReset();
    mocks.registerCreatedSession.mockReset();
  });

  it("registers the created entity and its Sidebar projection before returning", async () => {
    mocks.sessionLaunch.mockResolvedValue(
      launchResult({
        workspacePath: "/workspace/repo",
        workItemId: "ORG-42",
      })
    );

    await expect(
      SessionService.create({
        task: "Do the work",
        repoPath: "/workspace/repo",
        model: "gpt-5.6",
        mode: "build",
        agentDefinitionId: "builtin:sde",
        workItemId: "ORG-42",
      })
    ).resolves.toEqual({ sessionId: "sdeagent-service-created" });

    expect(mocks.registerCreatedSession).toHaveBeenCalledOnce();
    expect(mocks.registerCreatedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "sdeagent-service-created",
        repoPath: "/workspace/repo",
        agentDefinitionId: "builtin:sde",
        agentExecMode: "build",
        workItemId: "ORG-42",
      })
    );
  });

  it("does not register anything when the launch boundary fails", async () => {
    mocks.sessionLaunch.mockRejectedValue(new Error("launch failed"));

    await expect(
      SessionService.create({ task: "Do the work" })
    ).rejects.toThrow("Failed to create session: launch failed");
    expect(mocks.registerCreatedSession).not.toHaveBeenCalled();
  });
});

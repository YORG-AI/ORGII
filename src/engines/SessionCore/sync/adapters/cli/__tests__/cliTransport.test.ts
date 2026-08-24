import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendCliMessage } from "../cliTransport";

const mocks = vi.hoisted(() => ({
  enterIntervention: vi.fn(),
  message: vi.fn(),
  registerReceipt: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@src/api/tauri/agent", () => ({
  enterAgentOrgSessionIntervention: mocks.enterIntervention,
}));
vi.mock("@src/api/tauri/rpc", () => ({
  rpc: { cli: { message: mocks.message, cancel: vi.fn() } },
}));
vi.mock("@src/hooks/cliSession/cliTurnLifecycleCoordinator", () => ({
  cliTurnLifecycleCoordinator: { registerReceipt: mocks.registerReceipt },
}));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ warn: mocks.warn }),
}));

describe("sendCliMessage acceptance boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.message.mockResolvedValue({
      sessionId: "cliagent-worker",
      turnIntentId: "intent-1",
      effectiveTurnIntentId: "intent-1",
      status: "running",
      duplicate: false,
    });
    mocks.enterIntervention.mockReturnValue(new Promise(() => undefined));
  });

  it("resolves from the receipt without status or history reconciliation", async () => {
    await expect(
      sendCliMessage({
        sessionId: "cliagent-worker",
        content: "continue",
        turnIntentId: "intent-1",
        clientMessageId: "message-1",
        turnIntentSource: "user_submit",
        directUserIntent: true,
      })
    ).resolves.toEqual({
      duplicate: false,
      turnIntentStatus: "running",
      effectiveTurnIntentId: "intent-1",
    });

    expect(mocks.message).toHaveBeenCalledWith({
      request: {
        sessionId: "cliagent-worker",
        content: "continue",
        turnIntentId: "intent-1",
        clientMessageId: "message-1",
      },
    });
    expect(mocks.registerReceipt).toHaveBeenCalledWith({
      sessionId: "cliagent-worker",
      turnIntentId: "intent-1",
      effectiveTurnIntentId: "intent-1",
      status: "running",
      duplicate: false,
    });
    expect(mocks.enterIntervention).toHaveBeenCalledWith("cliagent-worker");
  });

  it("returns an exact running replay without repeating intervention", async () => {
    mocks.message.mockResolvedValue({
      sessionId: "cliagent-worker",
      turnIntentId: "intent-running",
      effectiveTurnIntentId: "intent-running",
      status: "running",
      duplicate: true,
    });

    await expect(
      sendCliMessage({
        sessionId: "cliagent-worker",
        content: "retry after response loss",
        turnIntentId: "intent-running",
        clientMessageId: "message-running",
        turnIntentSource: "user_submit",
        directUserIntent: true,
      })
    ).resolves.toEqual({
      duplicate: true,
      turnIntentStatus: "running",
      effectiveTurnIntentId: "intent-running",
    });

    expect(mocks.registerReceipt).toHaveBeenCalledWith({
      sessionId: "cliagent-worker",
      turnIntentId: "intent-running",
      effectiveTurnIntentId: "intent-running",
      status: "running",
      duplicate: true,
    });
    expect(mocks.enterIntervention).not.toHaveBeenCalled();
  });

  it("returns an exact completed replay without reopening the turn", async () => {
    mocks.message.mockResolvedValue({
      sessionId: "cliagent-worker",
      turnIntentId: "intent-completed",
      effectiveTurnIntentId: "intent-completed",
      status: "completed",
      duplicate: true,
    });

    await expect(
      sendCliMessage({
        sessionId: "cliagent-worker",
        content: "late retry",
        turnIntentId: "intent-completed",
        clientMessageId: "message-completed",
        turnIntentSource: "user_submit",
      })
    ).resolves.toEqual({
      duplicate: true,
      turnIntentStatus: "completed",
      effectiveTurnIntentId: "intent-completed",
    });

    expect(mocks.registerReceipt).toHaveBeenCalledWith({
      sessionId: "cliagent-worker",
      turnIntentId: "intent-completed",
      effectiveTurnIntentId: "intent-completed",
      status: "completed",
      duplicate: true,
    });
    expect(mocks.enterIntervention).not.toHaveBeenCalled();
  });

  it("returns a backend-selected effective Project intent", async () => {
    mocks.message.mockResolvedValue({
      sessionId: "cliagent-worker",
      turnIntentId: "intent-project-x",
      effectiveTurnIntentId: "wir_project-y",
      status: "queued",
      duplicate: false,
    });

    await expect(
      sendCliMessage({
        sessionId: "cliagent-worker",
        content: "project task",
        turnIntentId: "intent-project-x",
        clientMessageId: "message-project-x",
        turnIntentSource: "user_submit",
      })
    ).resolves.toEqual({
      duplicate: false,
      turnIntentStatus: "queued",
      effectiveTurnIntentId: "wir_project-y",
    });
    expect(mocks.registerReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        turnIntentId: "intent-project-x",
        effectiveTurnIntentId: "wir_project-y",
      })
    );
  });

  it("rejects only when the backend command rejects", async () => {
    mocks.message.mockRejectedValue(new Error("ipc unavailable"));

    await expect(
      sendCliMessage({
        sessionId: "cliagent-worker",
        content: "retry",
        turnIntentId: "intent-2",
        clientMessageId: "message-2",
        turnIntentSource: "user_submit",
      })
    ).rejects.toThrow("ipc unavailable");

    expect(mocks.registerReceipt).not.toHaveBeenCalled();
    expect(mocks.enterIntervention).not.toHaveBeenCalled();
  });

  it("rejects when the effective receipt cannot be attributed exactly", async () => {
    mocks.registerReceipt.mockImplementationOnce(() => {
      throw new Error("CLI effective turn intent wir-conflict conflicts");
    });

    await expect(
      sendCliMessage({
        sessionId: "cliagent-worker",
        content: "project task",
        turnIntentId: "intent-conflict",
        clientMessageId: "message-conflict",
        turnIntentSource: "user_submit",
        directUserIntent: true,
      })
    ).rejects.toThrow(/conflicts/);

    expect(mocks.enterIntervention).not.toHaveBeenCalled();
  });
});

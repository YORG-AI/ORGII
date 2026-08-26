import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendCliMessage } from "../cliTransport";

const mocks = vi.hoisted(() => ({
  message: vi.fn(),
  registerReceipt: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: { cli: { message: mocks.message, cancel: vi.fn() } },
}));
vi.mock("@src/hooks/cliSession/cliTurnLifecycleCoordinator", () => ({
  cliTurnLifecycleCoordinator: { registerReceipt: mocks.registerReceipt },
}));

describe("sendCliMessage acceptance boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.message.mockResolvedValue({
      sessionId: "cliagent-worker",
      turnIntentId: "intent-1",
      status: "running",
    });
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
    ).resolves.toBeUndefined();

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
      status: "running",
    });
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
  });

  it("rejects Agent Org direct source before invoking a CLI provider", async () => {
    await expect(
      sendCliMessage({
        sessionId: "cliagent-worker",
        content: "direct work",
        turnIntentSource: "user_submit",
        directUserIntent: true,
        agentOrgDirectSourceEventId: "event-direct-member",
      })
    ).rejects.toThrow("user_directed_target_invalid");

    expect(mocks.message).not.toHaveBeenCalled();
    expect(mocks.registerReceipt).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendCliMessage } from "../cliTransport";

const mocks = vi.hoisted(() => ({
  enterIntervention: vi.fn(),
  message: vi.fn(),
  registerReceipt: vi.fn(),
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

describe("sendCliMessage acceptance boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.message.mockResolvedValue({
      sessionId: "cliagent-worker",
      turnIntentId: "intent-1",
      status: "running",
    });
    mocks.enterIntervention.mockResolvedValue(undefined);
  });

  it("resolves from the receipt without status or history reconciliation", async () => {
    await expect(
      sendCliMessage({
        sessionId: "cliagent-worker",
        content: "continue",
        turnIntentId: "intent-1",
        clientMessageId: "message-1",
      })
    ).resolves.toBeUndefined();

    expect(mocks.message).toHaveBeenCalledWith({
      sessionId: "cliagent-worker",
      content: "continue",
      turnIntentId: "intent-1",
      clientMessageId: "message-1",
    });
    expect(mocks.registerReceipt).toHaveBeenCalledWith({
      sessionId: "cliagent-worker",
      turnIntentId: "intent-1",
      status: "running",
    });
  });

  it("rejects when the backend command rejects", async () => {
    mocks.message.mockRejectedValue(new Error("ipc unavailable"));

    await expect(
      sendCliMessage({
        sessionId: "cliagent-worker",
        content: "retry",
        isResume: true,
        turnIntentId: "intent-2",
        clientMessageId: "message-2",
      })
    ).rejects.toThrow("ipc unavailable");

    expect(mocks.registerReceipt).not.toHaveBeenCalled();
  });
});

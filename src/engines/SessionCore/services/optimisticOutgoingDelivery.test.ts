import { describe, expect, it, vi } from "vitest";

import { deliverOptimisticOutgoing } from "./optimisticOutgoingDelivery";

describe("deliverOptimisticOutgoing", () => {
  it("keeps an accepted transport result when projection diagnostics throw", async () => {
    const send = vi.fn(async () => "accepted");
    const reporterError = new Error("reporter failed");

    await expect(
      deliverOptimisticOutgoing({
        send,
        markSent: async () => {
          throw new Error("sent projection failed");
        },
        markFailed: vi.fn(),
        onProjectionError: async () => {
          throw reporterError;
        },
      })
    ).resolves.toBe("accepted");
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps the original transport rejection when projection diagnostics throw", async () => {
    const transportError = new Error("transport failed");
    const send = vi.fn(async () => {
      throw transportError;
    });

    await expect(
      deliverOptimisticOutgoing({
        send,
        markSent: vi.fn(),
        markFailed: async () => {
          throw new Error("failed projection failed");
        },
        onProjectionError: async () => {
          throw new Error("reporter failed");
        },
      })
    ).rejects.toBe(transportError);
    expect(send).toHaveBeenCalledOnce();
  });
});

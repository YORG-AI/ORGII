import { describe, expect, it, vi } from "vitest";

import { Message } from "@src/components/Message";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";

import { handleNonCursorLaunchError } from "./launchErrorHandling";

vi.mock("@src/components/Message", () => ({
  Message: { info: vi.fn(), error: vi.fn() },
}));

describe("handleNonCursorLaunchError", () => {
  it("reports a queued run as information and clears the draft", () => {
    const clearDraft = vi.fn();
    const setShowAddFundsModal = vi.fn();
    const setShowBuyCreditsModal = vi.fn();
    const showAuthError = vi.fn();

    handleNonCursorLaunchError({
      advancedConfig: {} as AdvancedConfig,
      clearDraft,
      error: new Error("PM_RUN_ERR:RUN_QUEUED:run-1:/repo"),
      setShowAddFundsModal,
      setShowBuyCreditsModal,
      showAuthError,
      t: ((key: string) => key) as never,
    });

    expect(clearDraft).toHaveBeenCalledWith(null);
    expect(Message.info).toHaveBeenCalledWith("errors.runQueuedBehindCheckout");
    expect(Message.error).not.toHaveBeenCalled();
    expect(showAuthError).not.toHaveBeenCalled();
    expect(setShowAddFundsModal).not.toHaveBeenCalled();
  });

  it("keeps ordinary launch failures as errors", () => {
    vi.mocked(Message.error).mockClear();
    handleNonCursorLaunchError({
      advancedConfig: {} as AdvancedConfig,
      clearDraft: vi.fn(),
      error: new Error("session not found"),
      setShowAddFundsModal: vi.fn(),
      setShowBuyCreditsModal: vi.fn(),
      showAuthError: vi.fn(),
      t: ((key: string) => key) as never,
    });
    expect(Message.error).toHaveBeenCalled();
  });
});

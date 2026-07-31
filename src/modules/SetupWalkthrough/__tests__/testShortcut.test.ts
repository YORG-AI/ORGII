import { describe, expect, it, vi } from "vitest";

import {
  createSetupWalkthroughTestUpdates,
  isSetupWalkthroughTestShortcut,
  runSetupWalkthroughTestEntry,
} from "../useSetupWalkthroughTestShortcut";

function shortcutEvent(
  overrides: Partial<Parameters<typeof isSetupWalkthroughTestShortcut>[0]> = {}
) {
  return {
    altKey: true,
    code: "KeyO",
    ctrlKey: false,
    isComposing: false,
    metaKey: true,
    repeat: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("setup walkthrough hidden test shortcut", () => {
  it("matches the platform primary modifier and rejects near misses", () => {
    expect(isSetupWalkthroughTestShortcut(shortcutEvent(), "MacIntel")).toBe(
      true
    );
    expect(
      isSetupWalkthroughTestShortcut(
        shortcutEvent({ ctrlKey: true, metaKey: false }),
        "Win32"
      )
    ).toBe(true);
    expect(
      isSetupWalkthroughTestShortcut(
        shortcutEvent({ altKey: false }),
        "MacIntel"
      )
    ).toBe(false);
    expect(
      isSetupWalkthroughTestShortcut(
        shortcutEvent({ shiftKey: true }),
        "MacIntel"
      )
    ).toBe(false);
    expect(
      isSetupWalkthroughTestShortcut(
        shortcutEvent({ repeat: true }),
        "MacIntel"
      )
    ).toBe(false);
  });

  it("creates a fresh reset without unrelated settings", () => {
    const first = createSetupWalkthroughTestUpdates();
    const second = createSetupWalkthroughTestUpdates();

    expect(first).toEqual({
      "general.setupWalkthroughOutcome": "open",
      "general.setupWalkthroughProgress": expect.objectContaining({
        goal: null,
        currentStepId: "goal",
        completedStepIds: [],
      }),
    });
    expect(Object.keys(first)).toEqual([
      "general.setupWalkthroughOutcome",
      "general.setupWalkthroughProgress",
    ]);
    expect(first["general.setupWalkthroughProgress"]).not.toBe(
      second["general.setupWalkthroughProgress"]
    );
  });

  it("navigates only after the atomic settings write succeeds", async () => {
    const events: string[] = [];
    const persist = vi.fn(async () => {
      events.push("persist");
    });
    const navigate = vi.fn(() => {
      events.push("navigate");
    });

    await runSetupWalkthroughTestEntry({ persist, navigate });

    expect(persist).toHaveBeenCalledWith(createSetupWalkthroughTestUpdates());
    expect(events).toEqual(["persist", "navigate"]);
  });

  it("does not navigate when resetting setup state fails", async () => {
    const navigate = vi.fn();

    await expect(
      runSetupWalkthroughTestEntry({
        persist: vi.fn().mockRejectedValue(new Error("disk unavailable")),
        navigate,
      })
    ).rejects.toThrow("disk unavailable");

    expect(navigate).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

import { applyRustSessionDeleteReceipt } from "../rustSessionDeleteReceipt";

function cleanupSpies() {
  return {
    removeSession: vi.fn(),
    removeForkRelayEntry: vi.fn(),
    disposeWorkstationWorkspace: vi.fn(),
    clearPendingFileOpens: vi.fn(),
    clearPendingCodeEditorTab: vi.fn(),
    evictEventStore: vi.fn().mockResolvedValue(undefined),
    closeSessionTabs: vi.fn().mockReturnValue(false),
  };
}

describe("applyRustSessionDeleteReceipt", () => {
  it("cleans every Agent Org descendant and evicts all receipt IDs", async () => {
    const cleanup = cleanupSpies();

    const deletedActiveSession = await applyRustSessionDeleteReceipt({
      requestedSessionId: "root",
      activeSessionId: "worker-b",
      isAgentOrgRoot: true,
      receipt: {
        deletedSessionIds: ["worker-a", "worker-b", "root"],
      },
      cleanup,
    });

    expect(deletedActiveSession).toBe(true);
    for (const cleanupFn of [
      cleanup.removeSession,
      cleanup.removeForkRelayEntry,
      cleanup.disposeWorkstationWorkspace,
      cleanup.clearPendingFileOpens,
      cleanup.clearPendingCodeEditorTab,
    ]) {
      expect(cleanupFn.mock.calls).toEqual([["worker-a"], ["worker-b"]]);
    }
    expect(cleanup.evictEventStore.mock.calls).toEqual([
      ["worker-a"],
      ["worker-b"],
      ["root"],
    ]);
    expect(cleanup.closeSessionTabs).toHaveBeenCalledWith([
      "worker-a",
      "worker-b",
      "root",
    ]);
  });

  it("closes the ordinary SDE tab while leaving data cleanup on the existing path", async () => {
    const cleanup = cleanupSpies();

    const deletedActiveSession = await applyRustSessionDeleteReceipt({
      requestedSessionId: "ordinary-session",
      activeSessionId: "ordinary-session",
      isAgentOrgRoot: false,
      receipt: {
        deletedSessionIds: ["ordinary-session"],
      },
      cleanup,
    });

    expect(deletedActiveSession).toBe(true);
    expect(cleanup.removeSession).not.toHaveBeenCalled();
    expect(cleanup.removeForkRelayEntry).not.toHaveBeenCalled();
    expect(cleanup.disposeWorkstationWorkspace).not.toHaveBeenCalled();
    expect(cleanup.clearPendingFileOpens).not.toHaveBeenCalled();
    expect(cleanup.clearPendingCodeEditorTab).not.toHaveBeenCalled();
    expect(cleanup.evictEventStore).not.toHaveBeenCalled();
    expect(cleanup.closeSessionTabs).toHaveBeenCalledWith(["ordinary-session"]);
  });

  it("does not request a second navigation when closing the active tab selected a safe fallback", async () => {
    const cleanup = cleanupSpies();
    cleanup.closeSessionTabs.mockReturnValue(true);

    const requiresNavigationReset = await applyRustSessionDeleteReceipt({
      requestedSessionId: "root",
      activeSessionId: "root",
      isAgentOrgRoot: true,
      receipt: {
        deletedSessionIds: ["worker", "root"],
      },
      cleanup,
    });

    expect(requiresNavigationReset).toBe(false);
    expect(cleanup.closeSessionTabs).toHaveBeenCalledWith(["worker", "root"]);
  });

  it("deduplicates malformed duplicate IDs before local cleanup", async () => {
    const cleanup = cleanupSpies();

    await applyRustSessionDeleteReceipt({
      requestedSessionId: "root",
      activeSessionId: "unrelated",
      isAgentOrgRoot: true,
      receipt: {
        deletedSessionIds: ["worker", "worker", "root"],
      },
      cleanup,
    });

    expect(cleanup.removeSession).toHaveBeenCalledTimes(1);
    expect(cleanup.removeSession).toHaveBeenCalledWith("worker");
    expect(cleanup.evictEventStore.mock.calls).toEqual([["worker"], ["root"]]);
    expect(cleanup.closeSessionTabs).toHaveBeenCalledWith(["worker", "root"]);
  });
});

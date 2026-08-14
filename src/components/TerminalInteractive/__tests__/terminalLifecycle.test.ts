import { beforeEach, describe, expect, it, vi } from "vitest";

import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";

import { cleanupPtyListeners } from "../terminalLifecycle";
import { unregisterPane } from "../terminalOutputScheduler";

vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: vi.fn().mockResolvedValue(undefined),
  isTauriReady: vi.fn().mockReturnValue(true),
}));
vi.mock("../terminalOutputScheduler", () => ({
  unregisterPane: vi.fn(),
}));

describe("cleanupPtyListeners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauriReady).mockReturnValue(true);
    vi.mocked(invokeTauri).mockResolvedValue(undefined);
  });

  it("detaches the renderer stream without closing the running PTY", () => {
    const unlistenOutput = vi.fn();
    const unlistenExit = vi.fn();
    const sessionIdRef = { current: "terminal-pty-agent-a" };

    cleanupPtyListeners({
      unlistenOutputRef: { current: unlistenOutput },
      unlistenExitRef: { current: unlistenExit },
      sessionIdRef,
    });

    expect(unlistenOutput).toHaveBeenCalledOnce();
    expect(unlistenExit).toHaveBeenCalledOnce();
    expect(unregisterPane).toHaveBeenCalledWith("terminal-pty-agent-a");
    expect(invokeTauri).toHaveBeenCalledWith("detach_pty_stream", {
      sessionId: "terminal-pty-agent-a",
    });
    expect(invokeTauri).not.toHaveBeenCalledWith(
      "close_pty",
      expect.anything()
    );
    expect(sessionIdRef.current).toBeNull();
  });

  it("still clears local listeners when Tauri is unavailable", () => {
    vi.mocked(isTauriReady).mockReturnValue(false);
    const unlistenOutput = vi.fn();
    const unlistenExit = vi.fn();
    const sessionIdRef = { current: "terminal-pty-browser" };

    cleanupPtyListeners({
      unlistenOutputRef: { current: unlistenOutput },
      unlistenExitRef: { current: unlistenExit },
      sessionIdRef,
    });

    expect(unlistenOutput).toHaveBeenCalledOnce();
    expect(unlistenExit).toHaveBeenCalledOnce();
    expect(unregisterPane).toHaveBeenCalledOnce();
    expect(invokeTauri).not.toHaveBeenCalled();
    expect(sessionIdRef.current).toBeNull();
  });
});

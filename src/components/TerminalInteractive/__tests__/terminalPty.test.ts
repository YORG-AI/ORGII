import { beforeEach, describe, expect, it, vi } from "vitest";

import { initPtyConnection } from "../terminalPty";

const listenTauri = vi.fn();
const invokeTauri = vi.fn();
const isTauriReady = vi.fn(() => true);

vi.mock("@src/util/platform/tauri/init", () => ({
  listenTauri: (event: string, handler: unknown) => listenTauri(event, handler),
  invokeTauri: (cmd: string, payload?: unknown) => invokeTauri(cmd, payload),
  isTauriReady: () => isTauriReady(),
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

vi.mock("../bufferCache", () => ({
  getTerminalBuffer: vi.fn(() => null),
  deleteTerminalBuffer: vi.fn(),
}));

vi.mock("../utils", () => ({
  writeBrowserModeMessage: vi.fn(),
}));

type Ref<T> = { current: T };

function ref<T>(value: T): Ref<T> {
  return { current: value };
}

function createFakeTerminal() {
  return {
    write: vi.fn(),
    writeln: vi.fn(),
    focus: vi.fn(),
    cols: 80,
    rows: 20,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createParams(overrides: Partial<Record<string, any>> = {}) {
  const terminal = overrides.terminal ?? createFakeTerminal();
  return {
    params: {
      cols: 80,
      rows: 20,
      sessionKey: "session-1",
      terminalRef: overrides.terminalRef ?? ref(terminal),
      sessionIdRef: ref<string | null>(null),
      unlistenOutputRef:
        overrides.unlistenOutputRef ?? ref<(() => void) | null>(null),
      unlistenExitRef:
        overrides.unlistenExitRef ?? ref<(() => void) | null>(null),
      repoPathRef: ref<string | undefined>(undefined),
      shellType: "default" as const,
      setIsBrowserMode: vi.fn(),
      setIsConnecting: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    terminal,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isTauriReady.mockReturnValue(true);
  // Default: pty does not exist yet, so a fresh session is created.
  invokeTauri.mockImplementation((cmd: string) => {
    if (cmd === "resize_pty") return Promise.reject(new Error("no pty"));
    if (cmd === "get_pty_info") {
      return Promise.resolve({
        session_id: "terminal-pty-session-1",
        pid: 1,
        shell: "/bin/zsh",
        cwd: null,
      });
    }
    return Promise.resolve();
  });
  // Each listen registration returns its own unique unlisten fn.
  listenTauri.mockImplementation(() => Promise.resolve(vi.fn()));
});

describe("initPtyConnection", () => {
  it("registers exactly one output + one exit listener for a fresh session", async () => {
    const { params, terminal } = createParams();

    await initPtyConnection(params);

    const listenedEvents = listenTauri.mock.calls.map((call) => call[0]);
    expect(listenedEvents).toEqual([
      "pty-output-terminal-pty-session-1",
      "pty-exit-terminal-pty-session-1",
    ]);
    expect(typeof params.unlistenOutputRef.current).toBe("function");
    expect(typeof params.unlistenExitRef.current).toBe("function");
    expect(terminal.focus).toHaveBeenCalledTimes(1);
  });

  it("tears down a previous listener before registering a new one (no stacking)", async () => {
    const prevOutput = vi.fn();
    const prevExit = vi.fn();
    const { params } = createParams({
      unlistenOutputRef: ref<(() => void) | null>(prevOutput),
      unlistenExitRef: ref<(() => void) | null>(prevExit),
    });

    await initPtyConnection(params);

    // The stale listeners from a prior init must be removed exactly once so a
    // second listener never ends up writing the same PTY output to xterm.
    expect(prevOutput).toHaveBeenCalledTimes(1);
    expect(prevExit).toHaveBeenCalledTimes(1);
    expect(params.unlistenOutputRef.current).not.toBe(prevOutput);
    expect(params.unlistenExitRef.current).not.toBe(prevExit);
  });

  it("drops the listener and bails if the terminal is replaced during async init", async () => {
    const terminal = createFakeTerminal();
    const terminalRef = ref<ReturnType<typeof createFakeTerminal> | null>(
      terminal
    );
    const droppedOutputUnlisten = vi.fn();

    // Simulate the xterm instance being disposed/recreated (ref reassigned)
    // while `listenTauri` is awaited.
    listenTauri.mockImplementationOnce(() => {
      terminalRef.current = createFakeTerminal();
      return Promise.resolve(droppedOutputUnlisten);
    });

    const { params } = createParams({ terminal, terminalRef });

    await initPtyConnection(params);

    expect(droppedOutputUnlisten).toHaveBeenCalledTimes(1);
    expect(params.unlistenOutputRef.current).toBeNull();
    expect(params.unlistenExitRef.current).toBeNull();
    // Bailed before touching the backend / registering the exit listener.
    expect(listenTauri).toHaveBeenCalledTimes(1);
    expect(
      invokeTauri.mock.calls.some((call) => call[0] === "resize_pty")
    ).toBe(false);
  });
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  refreshBoundedReplaySession,
  useExternalHistoryAutoRefresh,
} from "./externalHistoryAutoRefresh";

const mocks = vi.hoisted(() => ({
  getAdapterForSession: vi.fn(),
  getActiveExternalReplayLease: vi.fn(),
  getExternalReplayWatcherAvailable: vi.fn(() => false),
  pollExternalReplaySession: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  isWindowFocused: vi.fn(() => true),
  onWindowFocusRegained: vi.fn(() => vi.fn()),
  useAtomValue: vi.fn(() => true),
}));

const actEnvironment = globalThis as {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));
vi.mock("jotai", () => ({
  useAtomValue: mocks.useAtomValue,
}));
vi.mock("@src/store/session/dataSourceConfigAtom", () => ({
  externalSessionsEnabledAtom: {},
}));
vi.mock("@src/util/core/windowFocus", () => ({
  isWindowFocused: mocks.isWindowFocused,
  onWindowFocusRegained: mocks.onWindowFocusRegained,
}));

vi.mock("./types", () => ({
  getAdapterForSession: mocks.getAdapterForSession,
}));

vi.mock("./externalReplayTransport", () => ({
  getActiveExternalReplayLease: mocks.getActiveExternalReplayLease,
  getExternalReplayWatcherAvailable: mocks.getExternalReplayWatcherAvailable,
  pollExternalReplaySession: mocks.pollExternalReplaySession,
}));

describe("refreshBoundedReplaySession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdapterForSession.mockReturnValue({
      category: "external_history",
      historyMode: "bounded-replay",
    });
    mocks.getActiveExternalReplayLease.mockReturnValue({
      sessionId: "codexapp-active",
      epoch: 1,
    });
    mocks.pollExternalReplaySession.mockResolvedValue({
      cursor: {},
      events: [{ id: "event-1" }],
      removedEventIds: [],
      resetRequired: false,
      watcherAvailable: false,
      stats: { notReady: false },
    });
    mocks.listen.mockResolvedValue(mocks.unlisten);
  });

  it("polls one true delta for the active replay lease", async () => {
    const controller = new AbortController();

    await expect(
      refreshBoundedReplaySession("codexapp-active", controller.signal)
    ).resolves.toBe(true);

    expect(mocks.pollExternalReplaySession).toHaveBeenCalledWith(
      { sessionId: "codexapp-active", epoch: 1 },
      controller.signal
    );
  });

  it("does not invoke replay for a native ORGII agent", async () => {
    mocks.getAdapterForSession.mockReturnValue({
      category: "agent",
      historyMode: "persisted-db",
    });

    await expect(
      refreshBoundedReplaySession(
        "osagent-native",
        new AbortController().signal
      )
    ).resolves.toBe(false);

    expect(mocks.getActiveExternalReplayLease).not.toHaveBeenCalled();
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();
  });

  it("does no frontend work for an unchanged or not-ready source", async () => {
    mocks.pollExternalReplaySession.mockResolvedValue({
      cursor: {},
      events: [],
      removedEventIds: [],
      resetRequired: false,
      watcherAvailable: false,
      stats: { notReady: true },
    });

    await expect(
      refreshBoundedReplaySession(
        "codexapp-active",
        new AbortController().signal
      )
    ).resolves.toBe(false);
  });
});

function setDocumentVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

function RefreshHarness(props: {
  sessionId: string | null;
  intervalMs: number;
}) {
  useExternalHistoryAutoRefresh(props);
  return null;
}

describe("bounded replay refresh lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setDocumentVisibility("visible");
    mocks.isWindowFocused.mockReturnValue(true);
    mocks.useAtomValue.mockReturnValue(true);
    mocks.getAdapterForSession.mockReturnValue({
      category: "external_history",
      historyMode: "bounded-replay",
    });
    mocks.getActiveExternalReplayLease.mockReturnValue({
      sessionId: "codexapp-active",
      epoch: 1,
    });
    mocks.getExternalReplayWatcherAvailable.mockReturnValue(false);
    mocks.pollExternalReplaySession.mockResolvedValue({
      cursor: {},
      events: [],
      removedEventIds: [],
      resetRequired: false,
      watcherAvailable: false,
      stats: { notReady: false },
    });
    mocks.listen.mockResolvedValue(mocks.unlisten);
    mocks.onWindowFocusRegained.mockReturnValue(vi.fn());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function renderHarness(sessionId: string | null): Promise<void> {
    await act(async () => {
      root.render(
        createElement(RefreshHarness, { sessionId, intervalMs: 5_000 })
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function emitReplayInvalidation(payload: unknown): void {
    const listener = mocks.listen.mock.calls[0]?.[1] as
      | ((event: { payload: unknown }) => void)
      | undefined;
    expect(listener).toBeTypeOf("function");
    listener?.({ payload });
  }

  it("uses push invalidation plus a 60s safety tick when Rust reports a watcher", async () => {
    mocks.getExternalReplayWatcherAvailable.mockReturnValue(true);
    await renderHarness("codexapp-active");

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(55_000));
    expect(mocks.pollExternalReplaySession).toHaveBeenCalledTimes(1);
  });

  it("polls one bounded delta for a matching watcher invalidation only", async () => {
    mocks.getExternalReplayWatcherAvailable.mockReturnValue(true);
    await renderHarness("codexapp-active");

    await act(async () => {
      emitReplayInvalidation({
        sessionId: "codexapp-other",
        sourceId: "codex_app",
        generation: "generation-1",
      });
      await Promise.resolve();
    });
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();

    await act(async () => {
      emitReplayInvalidation({
        sessionId: "codexapp-active",
        sourceId: "codex_app",
        generation: "generation-1",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.pollExternalReplaySession).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch watcher work while the replay is hidden", async () => {
    setDocumentVisibility("hidden");
    mocks.getExternalReplayWatcherAvailable.mockReturnValue(true);
    await renderHarness("codexapp-active");

    await act(async () => {
      emitReplayInvalidation({
        sessionId: "codexapp-active",
        sourceId: "codex_app",
        generation: "generation-1",
      });
      await Promise.resolve();
    });
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();
  });

  it("uses the configured short delta fallback when Rust reports no watcher", async () => {
    mocks.getExternalReplayWatcherAvailable.mockReturnValue(false);
    await renderHarness("codexapp-active");

    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.pollExternalReplaySession).toHaveBeenCalledTimes(1);
  });

  it("upgrades an already-armed fallback to the 60s safety tick without an extra poll", async () => {
    mocks.getExternalReplayWatcherAvailable.mockReturnValue(false);
    await renderHarness("codexapp-active");

    mocks.getExternalReplayWatcherAvailable.mockReturnValue(true);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.pollExternalReplaySession).toHaveBeenCalledTimes(1);
  });

  it("keeps ORGII collaboration snapshots live when vendor history discovery is disabled", async () => {
    mocks.useAtomValue.mockReturnValue(false);
    mocks.getActiveExternalReplayLease.mockReturnValue({
      sessionId: "imported-session-active",
      epoch: 1,
    });
    await renderHarness("imported-session-active");

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.pollExternalReplaySession).toHaveBeenCalledTimes(1);
  });

  it("does not refresh discovered vendor history while discovery is disabled", async () => {
    mocks.useAtomValue.mockReturnValue(false);
    await renderHarness("codexapp-active");

    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();
  });

  it("owns no refresh timer while hidden or inactive", async () => {
    setDocumentVisibility("hidden");
    await renderHarness("codexapp-active");
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();

    setDocumentVisibility("visible");
    await act(async () => {
      root.render(
        createElement(RefreshHarness, { sessionId: null, intervalMs: 5_000 })
      );
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();
  });

  it("owns no refresh timer while the application window is unfocused", async () => {
    mocks.isWindowFocused.mockReturnValue(false);
    await renderHarness("codexapp-active");

    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(mocks.pollExternalReplaySession).not.toHaveBeenCalled();
  });

  it("aborts in-flight refresh work and removes the watcher listener on session switch", async () => {
    let finishFirstPoll!: () => void;
    let firstSignal: AbortSignal | undefined;
    mocks.getActiveExternalReplayLease.mockImplementation((sessionId) => ({
      sessionId,
      epoch: sessionId === "codexapp-a" ? 1 : 2,
    }));
    mocks.pollExternalReplaySession.mockImplementationOnce(
      (_lease, signal: AbortSignal) => {
        firstSignal = signal;
        return new Promise((resolve) => {
          finishFirstPoll = () =>
            resolve({
              cursor: {},
              events: [],
              removedEventIds: [],
              resetRequired: false,
              watcherAvailable: false,
              stats: { notReady: false },
            });
        });
      }
    );
    await renderHarness("codexapp-a");

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.pollExternalReplaySession).toHaveBeenCalledTimes(1);
    expect(firstSignal?.aborted).toBe(false);

    await renderHarness("codexapp-b");

    expect(firstSignal?.aborted).toBe(true);
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    finishFirstPoll();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The old completion sees its disposed hook episode and cannot arm a new
    // timer. Only B's own fallback tick may produce the next poll.
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(mocks.pollExternalReplaySession).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.pollExternalReplaySession).toHaveBeenCalledTimes(2);
    expect(mocks.pollExternalReplaySession.mock.calls[1]?.[0]).toEqual({
      sessionId: "codexapp-b",
      epoch: 2,
    });
  });
});

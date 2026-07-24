import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { externalReplayQueryWindow } from "@src/api/tauri/externalHistory/replay";

import {
  type ExternalReplaySessionLease,
  activateExternalReplaySession,
  deactivateExternalReplaySession,
  getExternalReplayCursorForTest,
  openExternalReplaySession,
  pollExternalReplaySession,
  readExternalReplaySession,
} from "./externalReplayTransport";

const mocks = vi.hoisted(() => ({
  openWindow: vi.fn(),
  pollDelta: vi.fn(),
  readWindow: vi.fn(),
  queryWindow: vi.fn(),
  release: vi.fn(async () => {}),
  deactivateTurnState: vi.fn(),
}));

vi.mock("@src/api/tauri/externalHistory/replay", () => ({
  resolveExternalReplayTarget: (sessionId: string) => ({
    sourceId: sessionId.startsWith("cliagent-") ? "managed_cli" : "codex_app",
    sessionId,
  }),
  externalReplayOpenWindow: mocks.openWindow,
  externalReplayPollDelta: mocks.pollDelta,
  externalReplayReadWindow: mocks.readWindow,
  externalReplayQueryWindow: mocks.queryWindow,
  externalReplayRelease: mocks.release,
}));

vi.mock("./externalReplayTurnState", () => ({
  deactivateExternalReplayTurnState: mocks.deactivateTurnState,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cursor(sessionId: string, revision: number) {
  return {
    sourceId: "codex_app" as const,
    sessionId,
    generation: "generation-1",
    revision,
    throughSequence: revision,
  };
}

function windowResult(sessionId: string, revision: number) {
  return {
    cursor: cursor(sessionId, revision),
    events: [],
    turnHeaders: [],
    totalEventCount: 0,
    totalTurnCount: 0,
    hasOlder: false,
    watcherAvailable: false,
    stats: {
      parsedBytes: 0,
      parsedRows: 0,
      normalizedEvents: 0,
      upsertedEvents: 0,
      removedEvents: 0,
      ipcBytes: 0,
      notReady: false,
    },
  };
}

function deltaResult(sessionId: string, revision: number) {
  return {
    cursor: cursor(sessionId, revision),
    events: [],
    removedEventIds: [],
    resetRequired: false,
    watcherAvailable: false,
    stats: {
      parsedBytes: 0,
      parsedRows: 0,
      normalizedEvents: 0,
      upsertedEvents: 0,
      removedEvents: 0,
      ipcBytes: 0,
      notReady: false,
    },
  };
}

let currentLease: ExternalReplaySessionLease | null = null;

describe("external replay transport coordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentLease = null;
  });

  afterEach(() => {
    if (currentLease) deactivateExternalReplaySession(currentLease);
  });

  it("single-flights concurrent polls and advances one cursor", async () => {
    currentLease = activateExternalReplaySession("codexapp-session-1");
    mocks.openWindow.mockResolvedValue(windowResult(currentLease.sessionId, 1));
    await openExternalReplaySession(currentLease);

    const pending = deferred<ReturnType<typeof deltaResult>>();
    mocks.pollDelta.mockReturnValue(pending.promise);
    const first = pollExternalReplaySession(currentLease);
    const second = pollExternalReplaySession(currentLease);

    expect(mocks.pollDelta).toHaveBeenCalledTimes(1);
    pending.resolve(deltaResult(currentLease.sessionId, 2));
    await expect(first).resolves.toEqual(
      deltaResult(currentLease.sessionId, 2)
    );
    await expect(second).resolves.toEqual(
      deltaResult(currentLease.sessionId, 2)
    );
    expect(getExternalReplayCursorForTest(currentLease)?.revision).toBe(2);
  });

  it("keeps an in-flight foreground poll valid while a pure hover query runs", async () => {
    currentLease = activateExternalReplaySession("codexapp-session-1");
    mocks.openWindow.mockResolvedValue(windowResult(currentLease.sessionId, 1));
    await openExternalReplaySession(currentLease);

    const pending = deferred<ReturnType<typeof deltaResult>>();
    mocks.pollDelta.mockReturnValue(pending.promise);
    mocks.queryWindow.mockResolvedValue(
      windowResult(currentLease.sessionId, 99)
    );
    const poll = pollExternalReplaySession(currentLease);
    await externalReplayQueryWindow({
      sessionId: currentLease.sessionId,
      limits: { maxTurns: 1, maxEvents: 1, maxIpcBytes: 64 * 1024 },
    });

    pending.resolve(deltaResult(currentLease.sessionId, 2));
    await expect(poll).resolves.toEqual(deltaResult(currentLease.sessionId, 2));
    expect(getExternalReplayCursorForTest(currentLease)?.revision).toBe(2);
    expect(mocks.openWindow).toHaveBeenCalledTimes(1);
    expect(mocks.pollDelta).toHaveBeenCalledTimes(1);
  });

  it("serializes an older-page read behind an in-flight foreground poll", async () => {
    currentLease = activateExternalReplaySession("codexapp-session-1");
    mocks.openWindow.mockResolvedValue(windowResult(currentLease.sessionId, 1));
    await openExternalReplaySession(currentLease);

    const pendingPoll = deferred<ReturnType<typeof deltaResult>>();
    mocks.pollDelta.mockReturnValue(pendingPoll.promise);
    const poll = pollExternalReplaySession(currentLease);
    mocks.readWindow.mockResolvedValue(windowResult(currentLease.sessionId, 1));
    const read = readExternalReplaySession(currentLease, { turnIndex: 0 });

    expect(mocks.readWindow).not.toHaveBeenCalled();
    pendingPoll.resolve(deltaResult(currentLease.sessionId, 2));
    await expect(poll).resolves.toEqual(deltaResult(currentLease.sessionId, 2));
    await expect(read).resolves.toEqual(
      windowResult(currentLease.sessionId, 1)
    );
    expect(mocks.readWindow).toHaveBeenCalledWith({
      sessionId: currentLease.sessionId,
      episodeId: currentLease.episodeId,
      turnIndex: 0,
    });
    expect(getExternalReplayCursorForTest(currentLease)?.revision).toBe(2);
  });

  it("queues different older pages and suppresses polls until both finish", async () => {
    currentLease = activateExternalReplaySession("codexapp-session-1");
    mocks.openWindow.mockResolvedValue(windowResult(currentLease.sessionId, 3));
    await openExternalReplaySession(currentLease);

    const firstPage = deferred<ReturnType<typeof windowResult>>();
    const secondPage = deferred<ReturnType<typeof windowResult>>();
    mocks.readWindow
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(secondPage.promise);
    const first = readExternalReplaySession(currentLease, { turnIndex: 1 });
    const second = readExternalReplaySession(currentLease, { turnIndex: 0 });

    await vi.waitFor(() => expect(mocks.readWindow).toHaveBeenCalledTimes(1));
    await expect(pollExternalReplaySession(currentLease)).resolves.toBeNull();
    expect(mocks.pollDelta).not.toHaveBeenCalled();

    firstPage.resolve(windowResult(currentLease.sessionId, 3));
    await expect(first).resolves.toEqual(
      windowResult(currentLease.sessionId, 3)
    );
    await vi.waitFor(() => expect(mocks.readWindow).toHaveBeenCalledTimes(2));
    secondPage.resolve(windowResult(currentLease.sessionId, 3));
    await expect(second).resolves.toEqual(
      windowResult(currentLease.sessionId, 3)
    );
    expect(
      mocks.readWindow.mock.calls.map(([options]) => options.turnIndex)
    ).toEqual([1, 0]);
    expect(getExternalReplayCursorForTest(currentLease)?.revision).toBe(3);
  });

  it("releases the exact backend episode on deactivate", () => {
    const lease = activateExternalReplaySession("codexapp-session-release");
    currentLease = lease;
    expect(lease.signal.aborted).toBe(false);
    deactivateExternalReplaySession(lease);
    currentLease = null;
    expect(lease.signal.aborted).toBe(true);
    expect(mocks.release).toHaveBeenCalledWith(
      lease.sessionId,
      lease.episodeId
    );
    expect(mocks.deactivateTurnState).toHaveBeenCalledWith(lease.sessionId);
  });

  it("drops a late A result after switching A→B→A", async () => {
    const firstA = activateExternalReplaySession("codexapp-session-a");
    const staleOpen = deferred<ReturnType<typeof windowResult>>();
    mocks.openWindow.mockReturnValueOnce(staleOpen.promise);
    const staleResult = openExternalReplaySession(firstA);

    deactivateExternalReplaySession(firstA);
    expect(firstA.signal.aborted).toBe(true);
    const sessionB = activateExternalReplaySession("codexapp-session-b");
    deactivateExternalReplaySession(sessionB);
    expect(sessionB.signal.aborted).toBe(true);
    currentLease = activateExternalReplaySession("codexapp-session-a");
    expect(currentLease.signal.aborted).toBe(false);

    staleOpen.resolve(windowResult(firstA.sessionId, 99));
    await expect(staleResult).resolves.toBeNull();
    expect(getExternalReplayCursorForTest(currentLease)).toBeNull();

    mocks.openWindow.mockResolvedValueOnce(
      windowResult(currentLease.sessionId, 1)
    );
    await openExternalReplaySession(currentLease);
    expect(getExternalReplayCursorForTest(currentLease)?.revision).toBe(1);
  });

  it("drops a late A poll and ignores its delayed cleanup after A→B→A", async () => {
    const firstA = activateExternalReplaySession("codexapp-session-a");
    mocks.openWindow.mockResolvedValue(windowResult(firstA.sessionId, 1));
    await openExternalReplaySession(firstA);

    const stalePoll = deferred<ReturnType<typeof deltaResult>>();
    mocks.pollDelta.mockReturnValueOnce(stalePoll.promise);
    const staleResult = pollExternalReplaySession(firstA);

    const sessionB = activateExternalReplaySession("codexapp-session-b");
    expect(firstA.signal.aborted).toBe(true);
    deactivateExternalReplaySession(sessionB);
    currentLease = activateExternalReplaySession("codexapp-session-a");
    const releaseCountBeforeStaleCleanup = mocks.release.mock.calls.length;

    // React can deliver an old effect cleanup after the same public session
    // id has already entered a new visible episode. It must not release A2.
    deactivateExternalReplaySession(firstA);
    expect(mocks.release).toHaveBeenCalledTimes(releaseCountBeforeStaleCleanup);
    expect(currentLease.signal.aborted).toBe(false);

    stalePoll.resolve(deltaResult(firstA.sessionId, 99));
    await expect(staleResult).resolves.toBeNull();
    expect(getExternalReplayCursorForTest(currentLease)).toBeNull();

    mocks.openWindow.mockResolvedValueOnce(
      windowResult(currentLease.sessionId, 2)
    );
    await openExternalReplaySession(currentLease);
    expect(getExternalReplayCursorForTest(currentLease)?.revision).toBe(2);
  });

  it("invalidates an in-flight completion when its signal aborts", async () => {
    currentLease = activateExternalReplaySession("codexapp-session-1");
    const pending = deferred<ReturnType<typeof windowResult>>();
    mocks.openWindow.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const result = openExternalReplaySession(currentLease, controller.signal);

    controller.abort();
    pending.resolve(windowResult(currentLease.sessionId, 3));

    await expect(result).resolves.toBeNull();
    expect(getExternalReplayCursorForTest(currentLease)).toBeNull();
  });
});

// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type QueuedMessage,
  messageQueueAtom,
} from "@src/store/ui/messageQueueAtom";
import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import { useQueueDispatch } from "../useQueueDispatch";

const SESSION_ID = "agent-builtin:sde-queued-worker";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  beginOptimisticTurn: vi.fn(),
  beginTurnDispatch: vi.fn(),
  cancelTurn: vi.fn(),
  confirmTurnRunning: vi.fn(),
  failOptimisticTurn: vi.fn(),
  getSession: vi.fn(),
  getTurnPhase: vi.fn(),
  markSessionActive: vi.fn(),
  markTurnTerminal: vi.fn(),
  messageError: vi.fn(),
  messageWarning: vi.fn(),
  removeByIdPrefix: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@src/api/tauri/agent", () => ({
  getSession: mocks.getSession,
}));

vi.mock("@src/components/Message", () => ({
  Message: {
    error: mocks.messageError,
    warning: mocks.messageWarning,
  },
}));

vi.mock("@src/engines/SessionCore/control/optimisticTurnStatus", () => ({
  beginOptimisticTurn: mocks.beginOptimisticTurn,
  failOptimisticTurn: mocks.failOptimisticTurn,
}));

vi.mock("@src/engines/SessionCore/control/sessionTimelineBoundary", () => ({
  cancelTurnForTimelineBoundary: mocks.cancelTurn,
}));

vi.mock("@src/engines/SessionCore/control/turnLifecycle", async () => {
  const { atom } = await import("jotai/vanilla");
  return {
    beginTurnDispatch: mocks.beginTurnDispatch,
    confirmTurnRunning: mocks.confirmTurnRunning,
    getTurnPhase: mocks.getTurnPhase,
    markTurnTerminal: mocks.markTurnTerminal,
    turnLifecycleSignalAtom: atom(0),
  };
});

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    append: mocks.append,
    removeByIdPrefix: mocks.removeByIdPrefix,
  },
}));

vi.mock("@src/engines/SessionCore/services/SessionService", () => ({
  SessionService: { sendMessage: mocks.sendMessage },
}));

vi.mock("@src/engines/SessionCore/sync/adapters/shared", () => ({
  createSyntheticUserEvent: () => ({ id: "synthetic-user-event" }),
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("@src/store/session", () => ({
  markSessionActive: mocks.markSessionActive,
}));

vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: vi.fn(),
}));

vi.mock("@src/util/session/resolveModelForMessage", () => ({
  resolveModelForMessage: () => ({
    model: "test-model",
    accountId: "test-account",
  }),
}));

vi.mock("@src/util/session/selectionFromSession", () => ({
  selectionFromSession: () => null,
}));

vi.mock("@src/util/session/sessionDispatch", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@src/util/session/sessionDispatch")
  >()),
  isAgentSession: () => false,
  isCliSession: () => false,
  isCursorIdeSession: () => false,
}));

function makeQueuedMessage(): QueuedMessage {
  return {
    id: "queued-intervention-1",
    turnIntentId: "turn-intent-queued-1",
    sessionId: SESSION_ID,
    content: "queued worker follow-up",
    displayContent: "queued worker follow-up",
    modelSelection: { model: "test-model" },
    agentExecMode: "build",
    priority: "now",
    status: "queued",
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}

function QueueDispatchHarness(): null {
  useQueueDispatch();
  return null;
}

describe("useQueueDispatch Agent Org intervention", () => {
  let root: SmokeRoot;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    mocks.append.mockReset().mockResolvedValue(undefined);
    mocks.beginOptimisticTurn.mockReset();
    mocks.beginTurnDispatch.mockReset().mockReturnValue(11);
    mocks.cancelTurn.mockReset().mockResolvedValue(undefined);
    mocks.confirmTurnRunning.mockReset();
    mocks.failOptimisticTurn.mockReset();
    mocks.getSession.mockReset().mockResolvedValue(null);
    mocks.getTurnPhase.mockReset().mockReturnValue("idle");
    mocks.markSessionActive.mockReset();
    mocks.markTurnTerminal.mockReset();
    mocks.messageError.mockReset();
    mocks.messageWarning.mockReset();
    mocks.removeByIdPrefix.mockReset().mockResolvedValue(1);
    mocks.sendMessage.mockReset().mockResolvedValue(undefined);
    store = createStore();
    root = createSmokeRoot();
  });

  afterEach(async () => {
    await root.unmount();
  });

  async function mountWithMessages(messages: QueuedMessage[]): Promise<void> {
    store.set(messageQueueAtom, messages);
    await root.render(
      createElement(Provider, { store }, createElement(QueueDispatchHarness))
    );
  }

  async function mountWithQueuedMessage(): Promise<void> {
    await mountWithMessages([makeQueuedMessage()]);
  }

  it("persists the queued event and dispatches it as direct user intent", async () => {
    await mountWithQueuedMessage();

    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce());

    expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        content: "queued worker follow-up",
        turnIntentId: "turn-intent-queued-1",
        directUserIntent: true,
      })
    );
    expect(mocks.append.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendMessage.mock.invocationCallOrder[0]
    );
    expect(store.get(messageQueueAtom)).toEqual([]);
  });

  it("does not let a blocked Send Now freeze another idle session", async () => {
    const blocked = makeQueuedMessage();
    const ready: QueuedMessage = {
      ...makeQueuedMessage(),
      id: "queued-other-session",
      turnIntentId: "turn-intent-other-session",
      sessionId: "agent-builtin:sde-other-session",
      content: "independent follow-up",
      displayContent: "independent follow-up",
      priority: "next",
    };
    mocks.getTurnPhase.mockImplementation((sessionId: string) =>
      sessionId === SESSION_ID ? "working" : "idle"
    );

    await mountWithMessages([blocked, ready]);

    await vi.waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: ready.sessionId })
      )
    );
    expect(mocks.cancelTurn).toHaveBeenCalledWith(SESSION_ID, "force-send");
    expect(store.get(messageQueueAtom)).toEqual([
      expect.objectContaining({ id: blocked.id }),
    ]);
  });

  it("removes the optimistic queued event when backend dispatch fails", async () => {
    mocks.sendMessage.mockRejectedValue(new Error("backend send unavailable"));

    await mountWithQueuedMessage();

    await vi.waitFor(() =>
      expect(mocks.removeByIdPrefix).toHaveBeenCalledWith(
        "synthetic-user-event",
        SESSION_ID
      )
    );

    expect(store.get(messageQueueAtom)).toEqual([
      expect.objectContaining({
        id: "queued-intervention-1",
        requiresExplicitDispatch: true,
      }),
    ]);
  });
});

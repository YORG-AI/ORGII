import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { messageQueueAtom } from "@src/store/ui/messageQueueAtom";

import {
  type SubmitUserIntentOptions,
  useUserIntentSubmit,
} from "./useUserIntentSubmit";

const SESSION_ID = "agent-builtin:sde-worker-intervention";

const mocks = vi.hoisted(() => ({
  addUserMessage: vi.fn(),
  beginOptimisticTurn: vi.fn(),
  beginTurnDispatch: vi.fn(),
  dispatchMessageBySessionType: vi.fn(),
  enterIntervention: vi.fn(),
  failOptimisticTurn: vi.fn(),
  getTurnPhase: vi.fn(),
  markTurnTerminal: vi.fn(),
  mintTurnIntentId: vi.fn(),
}));

vi.mock("@src/api/tauri/agent", () => ({
  enterAgentOrgSessionIntervention: mocks.enterIntervention,
}));

vi.mock("@src/engines/SessionCore/control/optimisticTurnStatus", () => ({
  beginOptimisticTurn: mocks.beginOptimisticTurn,
  failOptimisticTurn: mocks.failOptimisticTurn,
}));

vi.mock("@src/engines/SessionCore/control/turnLifecycle", () => ({
  beginTurnDispatch: mocks.beginTurnDispatch,
  getTurnPhase: mocks.getTurnPhase,
  markTurnTerminal: mocks.markTurnTerminal,
}));

vi.mock("@src/engines/SessionCore/sync/adapters/shared/eventFactories", () => ({
  mintTurnIntentId: mocks.mintTurnIntentId,
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("./useMessageDispatch", () => ({
  useMessageDispatch: () => ({
    addUserMessage: mocks.addUserMessage,
    dispatchMessageBySessionType: mocks.dispatchMessageBySessionType,
  }),
}));

function renderSubmitHook(store: ReturnType<typeof createStore>) {
  let submit: ((options: SubmitUserIntentOptions) => Promise<void>) | undefined;

  function HookProbe(): null {
    // Test probe: capture the hook API synchronously from server rendering.
    // eslint-disable-next-line react-hooks/globals
    submit = useUserIntentSubmit({ getSessionId: () => SESSION_ID });
    return null;
  }

  renderToString(createElement(Provider, { store }, createElement(HookProbe)));

  if (!submit) throw new Error("useUserIntentSubmit hook was not captured");
  return submit;
}

describe("useUserIntentSubmit Agent Org intervention", () => {
  beforeEach(() => {
    mocks.addUserMessage.mockReset().mockResolvedValue(undefined);
    mocks.beginOptimisticTurn.mockReset();
    mocks.beginTurnDispatch.mockReset().mockReturnValue(7);
    mocks.dispatchMessageBySessionType.mockReset().mockResolvedValue(undefined);
    mocks.enterIntervention.mockReset().mockResolvedValue(true);
    mocks.failOptimisticTurn.mockReset();
    mocks.getTurnPhase.mockReset().mockReturnValue("idle");
    mocks.markTurnTerminal.mockReset();
    mocks.mintTurnIntentId.mockReset().mockReturnValue("turn-intent-1");
  });

  it("marks intervention after persisting the direct user event and before dispatch", async () => {
    const submit = renderSubmitHook(createStore());

    await submit({ sessionId: SESSION_ID, displayContent: "hello worker" });

    expect(mocks.addUserMessage).toHaveBeenCalledOnce();
    expect(mocks.enterIntervention).toHaveBeenCalledOnce();
    expect(mocks.enterIntervention).toHaveBeenCalledWith(SESSION_ID);
    expect(mocks.dispatchMessageBySessionType).toHaveBeenCalledOnce();
    expect(mocks.addUserMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enterIntervention.mock.invocationCallOrder[0]
    );
    expect(mocks.enterIntervention.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatchMessageBySessionType.mock.invocationCallOrder[0]
    );
  });

  it("only enqueues while the current turn is busy", async () => {
    const store = createStore();
    const submit = renderSubmitHook(store);
    mocks.getTurnPhase.mockReturnValue("working");

    await submit({ sessionId: SESSION_ID, displayContent: "queued follow-up" });

    expect(store.get(messageQueueAtom)).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        content: "queued follow-up",
        displayContent: "queued follow-up",
        turnIntentId: "turn-intent-1",
        priority: "next",
        status: "queued",
      }),
    ]);
    expect(mocks.enterIntervention).not.toHaveBeenCalled();
    expect(mocks.dispatchMessageBySessionType).not.toHaveBeenCalled();
  });

  it("does not dispatch when intervention persistence fails", async () => {
    const submit = renderSubmitHook(createStore());
    mocks.enterIntervention.mockRejectedValue(
      new Error("intervention store unavailable")
    );

    await expect(
      submit({
        sessionId: SESSION_ID,
        displayContent: "take over this worker",
        swallowErrorAfterUserEventAppend: true,
      })
    ).resolves.toBeUndefined();

    expect(mocks.addUserMessage).toHaveBeenCalledOnce();
    expect(mocks.enterIntervention).toHaveBeenCalledOnce();
    expect(mocks.dispatchMessageBySessionType).not.toHaveBeenCalled();
    expect(mocks.failOptimisticTurn).toHaveBeenCalledWith(
      SESSION_ID,
      "dispatch"
    );
    expect(mocks.markTurnTerminal).toHaveBeenCalledWith(SESSION_ID, "failed", {
      generation: 7,
    });
  });
});

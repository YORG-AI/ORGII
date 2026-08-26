import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { postStopDispatchSessionsAtom } from "@src/store/session/cliSessionStatusAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom";
import { messageQueueAtom } from "@src/store/ui/messageQueueAtom";

import {
  type SubmitUserIntentOptions,
  isAgentOrgMemberDirectTarget,
  useUserIntentSubmit,
} from "./useUserIntentSubmit";

const SESSION_ID = "agent-builtin:sde-worker-intervention";

const mocks = vi.hoisted(() => ({
  addUserMessage: vi.fn(),
  beginOptimisticTurn: vi.fn(),
  beginTurnDispatch: vi.fn(),
  dispatchMessageBySessionType: vi.fn(),
  failOptimisticTurn: vi.fn(),
  getTurnPhase: vi.fn(),
  markTurnTerminal: vi.fn(),
  mintTurnIntentId: vi.fn(),
  removeByIdPrefix: vi.fn(),
  refreshAgentOrgRunView: vi.fn(),
}));

vi.mock(
  "@src/engines/ChatPanel/InputArea/components/agentOrgRunViewStore",
  () => ({
    refreshAgentOrgRunView: mocks.refreshAgentOrgRunView,
  })
);

vi.mock("@src/engines/SessionCore/control/optimisticTurnStatus", () => ({
  beginOptimisticTurn: mocks.beginOptimisticTurn,
  failOptimisticTurn: mocks.failOptimisticTurn,
}));

vi.mock("@src/engines/SessionCore/control/turnLifecycle", () => ({
  beginTurnDispatch: mocks.beginTurnDispatch,
  getTurnPhase: mocks.getTurnPhase,
  markTurnTerminal: mocks.markTurnTerminal,
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: { removeByIdPrefix: mocks.removeByIdPrefix },
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
    // eslint-disable-next-line react-hooks/globals -- server-rendered test probe synchronously exports the hook callback; the component never mounts or re-renders
    submit = useUserIntentSubmit({ getSessionId: () => SESSION_ID });
    return null;
  }

  renderToString(createElement(Provider, { store }, createElement(HookProbe)));

  if (!submit) throw new Error("useUserIntentSubmit hook was not captured");
  return submit;
}

describe("useUserIntentSubmit Agent Org intervention", () => {
  beforeEach(() => {
    mocks.addUserMessage.mockReset().mockResolvedValue("synthetic-user-1");
    mocks.beginOptimisticTurn.mockReset();
    mocks.beginTurnDispatch.mockReset().mockReturnValue(7);
    mocks.dispatchMessageBySessionType.mockReset().mockResolvedValue(undefined);
    mocks.failOptimisticTurn.mockReset();
    mocks.getTurnPhase.mockReset().mockReturnValue("idle");
    mocks.markTurnTerminal.mockReset();
    mocks.mintTurnIntentId.mockReset().mockReturnValue("turn-intent-1");
    mocks.removeByIdPrefix.mockReset().mockResolvedValue(1);
    mocks.refreshAgentOrgRunView.mockReset().mockResolvedValue(undefined);
  });

  it("recognizes only a materialized non-coordinator Member as direct", () => {
    expect(
      isAgentOrgMemberDirectTarget({
        parentSessionId: "root-session",
        orgMemberId: "member-direct",
      })
    ).toBe(true);
    expect(
      isAgentOrgMemberDirectTarget({
        parentSessionId: "root-session",
        orgMemberId: "coordinator",
      })
    ).toBe(false);
    expect(isAgentOrgMemberDirectTarget({ orgMemberId: "member-direct" })).toBe(
      false
    );
    expect(isAgentOrgMemberDirectTarget(undefined)).toBe(false);
  });

  it("appends the direct user event before dispatching the same intent", async () => {
    const submit = renderSubmitHook(createStore());

    await submit({ sessionId: SESSION_ID, displayContent: "hello worker" });

    expect(mocks.addUserMessage).toHaveBeenCalledWith(
      SESSION_ID,
      "hello worker",
      undefined,
      "turn-intent-1",
      false
    );
    expect(mocks.dispatchMessageBySessionType).toHaveBeenCalledOnce();
    expect(mocks.addUserMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatchMessageBySessionType.mock.invocationCallOrder[0]
    );
  });

  it("keeps a Stop episode scoped to its own session", async () => {
    const store = createStore();
    store.set(postStopDispatchSessionsAtom, { "session-a": true });
    const submit = renderSubmitHook(store);

    await submit({
      sessionId: SESSION_ID,
      displayContent: "session b message",
    });

    expect(store.get(messageQueueAtom)).toEqual([]);
    expect(mocks.dispatchMessageBySessionType).toHaveBeenCalledOnce();
    expect(store.get(postStopDispatchSessionsAtom)).toEqual({
      "session-a": true,
    });
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
    expect(mocks.dispatchMessageBySessionType).not.toHaveBeenCalled();
  });

  it("sends a busy canonical Member direct Turn to Rust with its exact source event", async () => {
    const store = createStore();
    store.set(sessionsAtom, [
      {
        session_id: SESSION_ID,
        status: "running",
        created_at: "2026-08-25T00:00:00Z",
        updated_at: "2026-08-25T00:00:00Z",
        orgMemberId: "member-direct",
        parentSessionId: "root-session",
      },
    ]);
    const submit = renderSubmitHook(store);
    mocks.getTurnPhase.mockReturnValue("working");

    await submit({
      sessionId: SESSION_ID,
      displayContent: "inspect the fixture",
    });

    expect(store.get(messageQueueAtom)).toEqual([]);
    expect(mocks.addUserMessage).toHaveBeenCalledWith(
      SESSION_ID,
      "inspect the fixture",
      undefined,
      "turn-intent-1",
      true
    );
    expect(mocks.dispatchMessageBySessionType).toHaveBeenCalledWith(
      SESSION_ID,
      "inspect the fixture",
      undefined,
      undefined,
      undefined,
      expect.stringMatching(/^direct:/),
      "turn-intent-1",
      7,
      "synthetic-user-1"
    );
    expect(mocks.refreshAgentOrgRunView).toHaveBeenCalledWith(SESSION_ID);
  });

  it("does not read the Agent Org projection for an ordinary SDE send", async () => {
    const submit = renderSubmitHook(createStore());

    await submit({ sessionId: SESSION_ID, displayContent: "ordinary send" });

    expect(mocks.dispatchMessageBySessionType).toHaveBeenCalledOnce();
    expect(mocks.refreshAgentOrgRunView).not.toHaveBeenCalled();
  });

  it("removes the optimistic user event and rejects when backend dispatch fails", async () => {
    const submit = renderSubmitHook(createStore());
    mocks.dispatchMessageBySessionType.mockRejectedValue(
      new Error("backend send unavailable")
    );

    await expect(
      submit({ sessionId: SESSION_ID, displayContent: "retry me" })
    ).rejects.toThrow("backend send unavailable");

    expect(mocks.addUserMessage).toHaveBeenCalledOnce();
    expect(mocks.removeByIdPrefix).toHaveBeenCalledWith(
      "synthetic-user-1",
      SESSION_ID
    );
  });

  it("keeps the durable Member user fact when typed backend dispatch fails", async () => {
    const store = createStore();
    store.set(sessionsAtom, [
      {
        session_id: SESSION_ID,
        status: "running",
        created_at: "2026-08-25T00:00:00Z",
        updated_at: "2026-08-25T00:00:00Z",
        orgMemberId: "member-direct",
        parentSessionId: "root-session",
      },
    ]);
    const submit = renderSubmitHook(store);
    mocks.dispatchMessageBySessionType.mockRejectedValue(
      new Error("user_directed_queue_full")
    );

    await expect(
      submit({ sessionId: SESSION_ID, displayContent: "preserve this fact" })
    ).rejects.toThrow("user_directed_queue_full");

    expect(mocks.addUserMessage).toHaveBeenCalledOnce();
    expect(mocks.removeByIdPrefix).not.toHaveBeenCalled();
  });
});

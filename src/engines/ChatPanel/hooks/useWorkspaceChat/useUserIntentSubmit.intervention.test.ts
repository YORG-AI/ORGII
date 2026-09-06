import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { postStopDispatchSessionsAtom } from "@src/store/session/cliSessionStatusAtom";
import { messageQueueAtom } from "@src/store/ui/messageQueueAtom";

import {
  type SubmitUserIntentOptions,
  useUserIntentSubmit,
} from "./useUserIntentSubmit";

const SESSION_ID = "agent-builtin:sde-worker-intervention";

const mocks = vi.hoisted(() => ({
  appendProjection: vi.fn(),
  beginOptimisticTurn: vi.fn(),
  dispatchMessageBySessionType: vi.fn(),
  flushQueue: vi.fn(),
  getTurnPhase: vi.fn(),
  mintTurnIntentId: vi.fn(),
  removeProjection: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/control/optimisticTurnStatus", () => ({
  beginOptimisticTurn: mocks.beginOptimisticTurn,
}));

vi.mock("@src/engines/SessionCore/control/turnLifecycle", () => ({
  getTurnPhase: mocks.getTurnPhase,
}));

vi.mock(
  "@src/engines/SessionCore/hooks/session/messageQueuePersistence",
  () => ({ flushMessageQueuePersistence: mocks.flushQueue })
);

vi.mock("@src/engines/SessionCore/services/userIntentDispatch", () => ({
  appendOptimisticQueueUserDelivery: mocks.appendProjection,
  removeOptimisticQueueUserDelivery: mocks.removeProjection,
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
    mocks.appendProjection.mockReset().mockResolvedValue(undefined);
    mocks.beginOptimisticTurn.mockReset();
    mocks.dispatchMessageBySessionType.mockReset().mockResolvedValue(undefined);
    mocks.flushQueue.mockReset().mockResolvedValue(undefined);
    mocks.getTurnPhase.mockReset().mockReturnValue("idle");
    mocks.mintTurnIntentId.mockReset().mockReturnValue("turn-intent-1");
    mocks.removeProjection.mockReset().mockResolvedValue(undefined);
  });

  it("routes the direct turn through the shared user-intent dispatcher", async () => {
    const submit = renderSubmitHook(createStore());

    await submit({ sessionId: SESSION_ID, displayContent: "hello worker" });

    expect(mocks.dispatchMessageBySessionType).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        content: "hello worker",
        visibleText: "hello worker",
        turnIntentId: "turn-intent-1",
      })
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

  it("admits canonical continuation through the same queue owner and durability barrier", async () => {
    const store = createStore();
    const submit = renderSubmitHook(store);
    const conversationDispatch = {
      kind: "canonical_conversation" as const,
      root: {
        authority: "local-session" as const,
        authorityScope: [],
        conversationId: "canonical-root",
      },
      target: {
        cliAgentType: "codex",
        accountId: "openai-1",
        model: "gpt-5.6-sol",
      },
    };
    mocks.flushQueue.mockImplementationOnce(async () => {
      expect(store.get(messageQueueAtom)).toEqual([
        expect.objectContaining({
          conversationDispatch,
          requiresExplicitDispatch: true,
          priority: "next",
        }),
      ]);
      expect(mocks.appendProjection).not.toHaveBeenCalled();
    });

    await submit({
      sessionId: SESSION_ID,
      displayContent: "continue natively",
      conversationDispatch,
    });

    const [queued] = store.get(messageQueueAtom);
    expect(queued).toMatchObject({
      conversationDispatch,
      content: "continue natively",
      displayContent: "continue natively",
    });
    expect(queued?.requiresExplicitDispatch).toBeUndefined();
    expect(mocks.appendProjection).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      visibleText: "continue natively",
      imageDataUrls: undefined,
      turnIntentId: "turn-intent-1",
      queueMessageId: queued?.id,
      createdAt: queued?.createdAt,
    });
    expect(mocks.dispatchMessageBySessionType).not.toHaveBeenCalled();
  });

  it("rolls canonical admission back when its durable owner cannot commit", async () => {
    const store = createStore();
    const submit = renderSubmitHook(store);
    mocks.flushQueue
      .mockRejectedValueOnce(new Error("delivery store unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(
      submit({
        sessionId: SESSION_ID,
        displayContent: "keep my draft",
        conversationDispatch: {
          kind: "canonical_conversation",
          root: {
            authority: "local-session",
            authorityScope: [],
            conversationId: "canonical-root",
          },
          target: {
            cliAgentType: "codex",
            accountId: "openai-1",
            model: "gpt-5.6-sol",
          },
        },
      })
    ).rejects.toThrow("delivery store unavailable");

    expect(store.get(messageQueueAtom)).toEqual([]);
    expect(mocks.appendProjection).not.toHaveBeenCalled();
    expect(mocks.flushQueue).toHaveBeenCalledTimes(2);
  });

  it("removes the durable canonical owner after a provable projection rollback", async () => {
    const store = createStore();
    const submit = renderSubmitHook(store);
    mocks.appendProjection.mockRejectedValueOnce(
      new Error("event store unavailable")
    );

    await expect(
      submit({
        sessionId: SESSION_ID,
        displayContent: "keep this draft too",
        conversationDispatch: {
          kind: "canonical_conversation",
          root: {
            authority: "local-session",
            authorityScope: [],
            conversationId: "canonical-root",
          },
          target: {
            cliAgentType: "codex",
            accountId: "openai-1",
            model: "gpt-5.6-sol",
          },
        },
      })
    ).rejects.toThrow("event store unavailable");

    expect(mocks.removeProjection).toHaveBeenCalledOnce();
    expect(store.get(messageQueueAtom)).toEqual([]);
    expect(mocks.flushQueue).toHaveBeenCalledTimes(2);
  });

  it("retains the canonical hold when projection rollback is not provable", async () => {
    const store = createStore();
    const submit = renderSubmitHook(store);
    mocks.appendProjection.mockRejectedValueOnce(new Error("append uncertain"));
    mocks.removeProjection.mockRejectedValueOnce(new Error("store offline"));

    await expect(
      submit({
        sessionId: SESSION_ID,
        displayContent: "never orphan this",
        conversationDispatch: {
          kind: "canonical_conversation",
          root: {
            authority: "local-session",
            authorityScope: [],
            conversationId: "canonical-root",
          },
          target: {
            cliAgentType: "codex",
            accountId: "openai-1",
            model: "gpt-5.6-sol",
          },
        },
      })
    ).rejects.toThrow("append uncertain");

    expect(store.get(messageQueueAtom)).toEqual([
      expect.objectContaining({
        requiresExplicitDispatch: true,
        priority: "next",
      }),
    ]);
    expect(mocks.flushQueue).toHaveBeenCalledOnce();
  });

  it("releases a post-Stop canonical turn with the existing now priority", async () => {
    const store = createStore();
    store.set(postStopDispatchSessionsAtom, { [SESSION_ID]: true });
    const submit = renderSubmitHook(store);

    await submit({
      sessionId: SESSION_ID,
      displayContent: "continue after stop",
      conversationDispatch: {
        kind: "canonical_conversation",
        root: {
          authority: "local-session",
          authorityScope: [],
          conversationId: "canonical-root",
        },
        target: {
          cliAgentType: "codex",
          accountId: "openai-1",
          model: "gpt-5.6-sol",
        },
      },
    });

    const [queued] = store.get(messageQueueAtom);
    expect(queued).toEqual(expect.objectContaining({ priority: "now" }));
    expect(queued?.requiresExplicitDispatch).toBeUndefined();
  });

  it("does not run a second optimistic-row cleanup when dispatch fails", async () => {
    const submit = renderSubmitHook(createStore());
    mocks.dispatchMessageBySessionType.mockRejectedValue(
      new Error("backend send unavailable")
    );

    await expect(
      submit({ sessionId: SESSION_ID, displayContent: "retry me" })
    ).rejects.toThrow("backend send unavailable");

    expect(mocks.dispatchMessageBySessionType).toHaveBeenCalledOnce();
  });
});

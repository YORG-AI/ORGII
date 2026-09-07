// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { QueuedConversationDispatch } from "@src/engines/SessionCore/conversations/queuedConversationContract";

import type { OptimizedChatItem } from "../../chatItemPipeline/types";
import { useEditUserMessage } from "../useEditUserMessage";

const {
  checkSnapshotChangesSpy,
  durableHydrationRows,
  flushMessageQueueSpy,
  hydrateMessageQueueSpy,
  messageQueueHydrated,
  queuedDeliveries,
  removeByIdPrefixSpy,
  updateByIdSpy,
  storeSetSpy,
  surfaceSessionId,
  submitUserIntentSpy,
  refreshMessageDeliveriesSpy,
  storeSessionId,
  truncateBeforeIdSpy,
} = vi.hoisted(() => ({
  checkSnapshotChangesSpy: vi.fn(async () => false),
  durableHydrationRows: { current: [] as Array<Record<string, unknown>> },
  flushMessageQueueSpy: vi.fn(async () => undefined),
  hydrateMessageQueueSpy: vi.fn(async () => undefined),
  messageQueueHydrated: { current: true },
  queuedDeliveries: { current: [] as Array<Record<string, unknown>> },
  removeByIdPrefixSpy: vi.fn(async () => 1),
  updateByIdSpy: vi.fn(async () => true),
  storeSetSpy: vi.fn((_atom: unknown, _update: unknown) => true),
  surfaceSessionId: { current: undefined as string | undefined },
  submitUserIntentSpy: vi.fn(async (..._args: unknown[]) => undefined),
  refreshMessageDeliveriesSpy: vi.fn(async () => undefined),
  storeSessionId: { current: "osagent-session-1" },
  truncateBeforeIdSpy: vi.fn(async () => undefined),
}));

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useSetAtom: () => vi.fn(),
  useStore: () => ({
    get: (atom: { debugLabel?: string }) =>
      atom.debugLabel === "messageQueueAtom"
        ? queuedDeliveries.current
        : atom.debugLabel === "messageQueueHydratedAtom"
          ? messageQueueHydrated.current
          : storeSessionId.current,
    set: storeSetSpy,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@src/api/tauri/agent", () => ({
  checkSnapshotChanges: checkSnapshotChangesSpy,
  truncateAfterMessage: vi.fn(async () => undefined),
}));

vi.mock("@src/components/Message", () => ({
  default: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@src/engines/ChatPanel/ChatSessionContext", () => ({
  useChatSessionId: () => surfaceSessionId.current,
}));

vi.mock(
  "@src/engines/ChatPanel/hooks/useWorkspaceChat/useUserIntentSubmit",
  () => ({
    useUserIntentSubmit: () => submitUserIntentSpy,
  })
);

vi.mock("@src/engines/SessionCore", () => ({
  editTruncationTimestampAtom: {},
}));

vi.mock("@src/engines/SessionCore/control/optimisticTurnStatus", () => ({
  beginOptimisticTurn: vi.fn(),
  failOptimisticTurn: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/control/sessionTimelineBoundary", () => ({
  cancelTurnForTimelineBoundary: vi.fn(async () => undefined),
}));

vi.mock("@src/engines/SessionCore/core/atoms", () => ({
  sessionIdAtom: {},
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    removeByIdPrefix: removeByIdPrefixSpy,
    updateById: updateByIdSpy,
    truncateBeforeId: truncateBeforeIdSpy,
    evictSession: vi.fn(async () => undefined),
  },
}));

vi.mock(
  "@src/engines/SessionCore/hooks/session/messageQueuePersistence",
  () => ({
    flushMessageQueuePersistence: flushMessageQueueSpy,
    hydrateMessageQueue: hydrateMessageQueueSpy,
    refreshMessageDeliveries: refreshMessageDeliveriesSpy,
  })
);

vi.mock("@src/engines/SessionCore/storage/cacheAdapter", () => ({
  deleteSession: vi.fn(async () => undefined),
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@src/store/session/planApprovalAtom", () => ({
  clearPendingPlanApproval: vi.fn((prev: unknown) => prev),
  pendingPlanApprovalsAtom: {},
}));

vi.mock("@src/store/session/viewAtom", () => ({
  activeSessionIdAtom: {},
}));

vi.mock("@src/store/ui/todoAtom", () => ({
  clearTodosForSessionAtom: {},
}));

vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: vi.fn(async () => 0),
}));

vi.mock("../../components/RevertConfirmDialog", () => ({
  showRevertConfirm: vi.fn(async () => "revert"),
}));

function chatItem(): OptimizedChatItem {
  return {
    event: {
      id: "user-message-abc",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    chunk_id: "chunk-1",
  } as unknown as OptimizedChatItem;
}

type EditUserMessageFn = (
  item: OptimizedChatItem,
  newText: string,
  imageDataUrls?: string[]
) => Promise<void>;

let resolveDispatchForTest:
  | (() => QueuedConversationDispatch | null)
  | undefined;

function resolveDispatchViaTest(): QueuedConversationDispatch | null {
  return resolveDispatchForTest?.() ?? null;
}

function Harness({ onReady }: { onReady: (fn: EditUserMessageFn) => void }) {
  const editUserMessage = useEditUserMessage(undefined, resolveDispatchViaTest);
  useEffect(() => {
    onReady(editUserMessage);
  }, [editUserMessage, onReady]);
  return null;
}

describe("useEditUserMessage resend projection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let editUserMessage: EditUserMessageFn | null = null;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    checkSnapshotChangesSpy.mockClear();
    durableHydrationRows.current = [];
    flushMessageQueueSpy.mockClear();
    hydrateMessageQueueSpy.mockClear();
    hydrateMessageQueueSpy.mockImplementation(async () => {
      queuedDeliveries.current = [...durableHydrationRows.current];
      messageQueueHydrated.current = true;
    });
    messageQueueHydrated.current = true;
    queuedDeliveries.current = [];
    removeByIdPrefixSpy.mockClear();
    updateByIdSpy.mockClear();
    storeSetSpy.mockClear();
    submitUserIntentSpy.mockClear();
    refreshMessageDeliveriesSpy.mockClear();
    truncateBeforeIdSpy.mockClear();
    storeSessionId.current = "osagent-session-1";
    surfaceSessionId.current = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(Harness, {
          onReady: (fn: EditUserMessageFn) => {
            editUserMessage = fn;
          },
        })
      )
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    editUserMessage = null;
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("re-runs the outgoing projection so the agent gets the contract, not raw pills", async () => {
    await act(async () => {
      await editUserMessage?.(
        chatItem(),
        "canvas [skill:/canvas] build a timer"
      );
    });

    expect(submitUserIntentSpy).toHaveBeenCalledTimes(1);
    const call = submitUserIntentSpy.mock.calls[0]?.[0] as unknown as {
      displayContent: string;
      agentContent?: string;
    };
    expect(call.displayContent).toBe("canvas [skill:/canvas] build a timer");
    expect(call.agentContent).toContain("render_inline_canvas exactly once");
    expect(call.agentContent).toContain("build a timer");
    expect(call.agentContent).not.toContain("[skill:/canvas]");
  });

  it("leaves plain edits without a separate agent copy", async () => {
    await act(async () => {
      await editUserMessage?.(chatItem(), "just fix the test");
    });

    const call = submitUserIntentSpy.mock.calls[0]?.[0] as unknown as {
      displayContent: string;
      agentContent?: string;
    };
    expect(call.displayContent).toBe("just fix the test");
    expect(call.agentContent).toBeUndefined();
  });

  it("does not project the canvas contract when resending with images", async () => {
    await act(async () => {
      await editUserMessage?.(chatItem(), "/canvas build a timer", [
        "data:image/png;base64,AAA",
      ]);
    });

    const call = submitUserIntentSpy.mock.calls[0]?.[0] as unknown as {
      displayContent: string;
      agentContent?: string;
    };
    expect(call.displayContent).toBe("/canvas build a timer");
    expect(call.agentContent).toBeUndefined();
  });

  it("retries a failed delivery without truncating later history", async () => {
    const failed = {
      event: {
        id: "user-input-failed",
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "user",
        functionName: "user_message",
        uiCanonical: "",
        displayText: "retry this exact request",
        displayStatus: "failed",
        result: {
          syntheticUserInput: true,
          deliveryStatus: "failed",
          turnIntentId: "turn-intent-failed",
        },
      },
      chunk_id: "user-input-failed",
    } as unknown as OptimizedChatItem;

    await act(async () => {
      await editUserMessage?.(failed, "retry this exact request");
    });

    expect(submitUserIntentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        displayContent: "retry this exact request",
        turnIntentId: "turn-intent-failed",
      })
    );
    expect(removeByIdPrefixSpy).toHaveBeenCalledWith(
      "user-input-failed",
      "osagent-session-1"
    );
    expect(checkSnapshotChangesSpy).not.toHaveBeenCalled();
    expect(truncateBeforeIdSpy).not.toHaveBeenCalled();
  });

  it("retries a reconciled orphan through the current submit path", async () => {
    const failed = {
      event: {
        id: "queued-user:legacy-orphan:",
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "user",
        functionName: "user_message",
        uiCanonical: "",
        displayText: "@VantaNode inspect this",
        displayStatus: "failed",
        result: {
          syntheticUserInput: true,
          deliveryStatus: "failed",
          deliveryError:
            "This message was not sent because its pending delivery could not be recovered. Retry to send it again.",
          turnIntentId: "turn-intent-orphan",
          message: {
            role: "user",
            content: "@VantaNode inspect this",
          },
          images: ["data:image/png;base64,keep"],
          mentions: [{ id: "vanta", label: "VantaNode" }],
        },
      },
      chunk_id: "queued-user:legacy-orphan:",
    } as unknown as OptimizedChatItem;

    await act(async () => {
      await editUserMessage?.(failed, "@VantaNode inspect this", [
        "data:image/png;base64,keep",
      ]);
    });

    expect(refreshMessageDeliveriesSpy).not.toHaveBeenCalled();
    expect(submitUserIntentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "osagent-session-1",
        displayContent: "@VantaNode inspect this",
        imageDataUrls: ["data:image/png;base64,keep"],
        turnIntentId: "turn-intent-orphan",
      })
    );
    expect(removeByIdPrefixSpy).toHaveBeenCalledWith(
      "queued-user:legacy-orphan:",
      "osagent-session-1"
    );
    expect(storeSetSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ debugLabel: "forceSendMessageAtom" }),
      expect.anything()
    );
  });

  it("retries a hydrated failed queue row in place without losing attachments", async () => {
    queuedDeliveries.current = [
      {
        id: "queue-failed",
        turnIntentId: "turn-intent-failed",
        sessionId: "osagent-session-1",
        content: "retry this exact request",
        displayContent: "retry this exact request",
        imageDataUrls: ["data:image/png;base64,keep"],
        priority: "next",
        status: "queued",
        requiresExplicitDispatch: true,
        deliveryError: "provider unavailable",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const failed = {
      event: {
        id: "queued-user-turn-intent-failed",
        displayText: "retry this exact request",
        displayStatus: "failed",
        result: {
          syntheticUserInput: true,
          deliveryStatus: "failed",
          queueMessageId: "queue-failed",
          turnIntentId: "turn-intent-failed",
        },
      },
      chunk_id: "queued-user-turn-intent-failed",
    } as unknown as OptimizedChatItem;

    await act(async () => {
      await editUserMessage?.(failed, "retry this exact request");
    });

    expect(updateByIdSpy).toHaveBeenCalledWith(
      "queued-user:queue-failed:",
      expect.objectContaining({
        displayText: "retry this exact request",
        displayStatus: "pending",
        result: expect.objectContaining({
          images: ["data:image/png;base64,keep"],
          turnIntentId: expect.not.stringMatching("turn-intent-failed"),
          deliveryStatus: "pending",
          queueMessageId: "queue-failed",
        }),
      }),
      "osagent-session-1"
    );
    expect(removeByIdPrefixSpy).not.toHaveBeenCalled();
    expect(storeSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ debugLabel: "forceSendMessageAtom" }),
      "queue-failed"
    );
  });

  it("retries a held canonical row with the runtime the picker shows now", async () => {
    const admittedDispatch: QueuedConversationDispatch = {
      kind: "canonical_conversation",
      root: {
        authority: "local-session",
        authorityScope: [],
        conversationId: "osagent-session-1",
      },
      target: {
        cliAgentType: "codex",
        accountId: "openai-1",
        model: "gpt-5.3-codex-medium",
      },
    };
    const currentDispatch: QueuedConversationDispatch = {
      ...admittedDispatch,
      target: {
        cliAgentType: "codex",
        accountId: "openai-1",
        model: "gpt-5.6-sol",
      },
    };
    resolveDispatchForTest = () => currentDispatch;
    queuedDeliveries.current = [
      {
        id: "queue-rejected",
        turnIntentId: "turn-intent-rejected",
        sessionId: "osagent-session-1",
        content: "reply with the marker",
        displayContent: "reply with the marker",
        priority: "next",
        status: "queued",
        requiresExplicitDispatch: true,
        deliveryError: "model not supported",
        createdAt: "2026-01-01T00:00:00.000Z",
        conversationDispatch: admittedDispatch,
      },
    ];
    const failed = {
      event: {
        id: "queued-user-turn-intent-rejected",
        displayText: "reply with the marker",
        displayStatus: "failed",
        result: {
          syntheticUserInput: true,
          deliveryStatus: "failed",
          queueMessageId: "queue-rejected",
          turnIntentId: "turn-intent-rejected",
        },
      },
      chunk_id: "queued-user-turn-intent-rejected",
    } as unknown as OptimizedChatItem;

    try {
      await act(async () => {
        await editUserMessage?.(failed, "reply with the marker");
      });
    } finally {
      resolveDispatchForTest = undefined;
    }

    expect(storeSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ debugLabel: "editMessageAtom" }),
      expect.objectContaining({
        messageId: "queue-rejected",
        conversationDispatch: currentDispatch,
      })
    );
    expect(storeSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ debugLabel: "forceSendMessageAtom" }),
      "queue-rejected"
    );
  });

  it("hydrates a cold failed owner and patches its runner row from the root surface", async () => {
    messageQueueHydrated.current = false;
    durableHydrationRows.current = [
      {
        id: "queue-cold",
        turnIntentId: "turn-intent-cold",
        // The canonical root is mounted, but the queue projection belongs to
        // the concrete local execution Session selected at admission.
        sessionId: "cliagent-runner-child",
        content: "cold retry",
        displayContent: "cold retry",
        priority: "next",
        status: "queued",
        requiresExplicitDispatch: true,
        deliveryError: "database is locked",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const failed = {
      event: {
        id: "queued-user:queue-cold:",
        sessionId: "cliagent-runner-child",
        displayText: "cold retry",
        displayStatus: "failed",
        result: {
          syntheticUserInput: true,
          deliveryStatus: "failed",
          queueMessageId: "queue-cold",
          turnIntentId: "turn-intent-cold",
        },
      },
      chunk_id: "queued-user:queue-cold:",
    } as unknown as OptimizedChatItem;

    await act(async () => {
      await editUserMessage?.(failed, "cold retry");
    });

    expect(hydrateMessageQueueSpy).toHaveBeenCalledOnce();
    expect(refreshMessageDeliveriesSpy).not.toHaveBeenCalled();
    expect(updateByIdSpy).toHaveBeenCalledWith(
      "queued-user:queue-cold:",
      expect.objectContaining({
        displayText: "cold retry",
        displayStatus: "pending",
      }),
      "cliagent-runner-child"
    );
    expect(removeByIdPrefixSpy).not.toHaveBeenCalled();
    expect(submitUserIntentSpy).not.toHaveBeenCalled();
  });

  it("never deletes a queue-owned bubble while its cold owner is unavailable", async () => {
    messageQueueHydrated.current = false;
    const failed = {
      event: {
        id: "queued-user:queue-missing:",
        displayText: "keep this failed row",
        displayStatus: "failed",
        result: {
          syntheticUserInput: true,
          deliveryStatus: "failed",
          queueMessageId: "queue-missing",
          turnIntentId: "turn-intent-missing",
        },
      },
      chunk_id: "queued-user:queue-missing:",
    } as unknown as OptimizedChatItem;

    await act(async () => {
      await editUserMessage?.(failed, "keep this failed row");
    });

    expect(hydrateMessageQueueSpy).toHaveBeenCalledOnce();
    expect(refreshMessageDeliveriesSpy).toHaveBeenCalledOnce();
    expect(removeByIdPrefixSpy).not.toHaveBeenCalled();
    expect(submitUserIntentSpy).not.toHaveBeenCalled();
    expect(updateByIdSpy).not.toHaveBeenCalled();
  });

  it("retries a retired failed delivery as a fresh intent", async () => {
    messageQueueHydrated.current = true;
    const failed = {
      event: {
        id: "queued-user:queue-retired:",
        source: "user",
        displayText: "retry after the owner retired",
        displayStatus: "failed",
        result: {
          syntheticUserInput: true,
          deliveryStatus: "failed",
          deliveryOwnerRetired: true,
          queueMessageId: "queue-retired",
          turnIntentId: "turn-intent-retired",
        },
      },
      chunk_id: "queued-user:queue-retired:",
    } as unknown as OptimizedChatItem;

    await act(async () => {
      await editUserMessage?.(failed, "retry after the owner retired");
    });

    expect(refreshMessageDeliveriesSpy).toHaveBeenCalledOnce();
    expect(submitUserIntentSpy).toHaveBeenCalledOnce();
    expect(submitUserIntentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        displayContent: "retry after the owner retired",
        turnIntentId: "turn-intent-retired",
      })
    );
    expect(removeByIdPrefixSpy).toHaveBeenCalledWith(
      "queued-user:queue-retired:",
      expect.any(String)
    );
  });

  it("edits a hydrated failed queue row and patches its existing bubble", async () => {
    queuedDeliveries.current = [
      {
        id: "queue-failed",
        turnIntentId: "turn-intent-failed",
        sessionId: "osagent-session-1",
        content: "retry this exact request",
        displayContent: "retry this exact request",
        imageDataUrls: ["data:image/png;base64,old"],
        priority: "next",
        status: "queued",
        requiresExplicitDispatch: true,
        deliveryError: "provider unavailable",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const failed = {
      event: {
        id: "queued-user-turn-intent-failed",
        displayText: "retry this exact request",
        displayStatus: "failed",
        result: {
          syntheticUserInput: true,
          deliveryStatus: "failed",
          queueMessageId: "queue-failed",
          turnIntentId: "turn-intent-failed",
        },
      },
      chunk_id: "queued-user-turn-intent-failed",
    } as unknown as OptimizedChatItem;

    await act(async () => {
      await editUserMessage?.(failed, "@VantaNode inspect the retry", [
        "data:image/png;base64,new",
      ]);
    });

    expect(storeSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ debugLabel: "editMessageAtom" }),
      expect.objectContaining({
        messageId: "queue-failed",
        content: "@VantaNode inspect the retry",
        imageDataUrls: ["data:image/png;base64,new"],
        turnIntentId: expect.any(String),
      })
    );
    expect(flushMessageQueueSpy).toHaveBeenCalledOnce();
    expect(updateByIdSpy).toHaveBeenCalledWith(
      "queued-user:queue-failed:",
      expect.objectContaining({
        displayText: "@VantaNode inspect the retry",
        displayStatus: "pending",
        result: expect.objectContaining({
          message: {
            role: "user",
            content: "@VantaNode inspect the retry",
          },
          images: ["data:image/png;base64,new"],
          turnIntentId: expect.any(String),
          deliveryStatus: "pending",
          queueMessageId: "queue-failed",
        }),
      }),
      "osagent-session-1"
    );
    expect(removeByIdPrefixSpy).not.toHaveBeenCalled();
    expect(storeSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ debugLabel: "forceSendMessageAtom" }),
      "queue-failed"
    );
    expect(submitUserIntentSpy).not.toHaveBeenCalled();
  });

  it("retries against the mounted SideChat session instead of global active", async () => {
    surfaceSessionId.current = "osagent-side-chat";
    storeSessionId.current = "osagent-main-chat";
    act(() =>
      root.render(
        createElement(Harness, {
          onReady: (fn: EditUserMessageFn) => {
            editUserMessage = fn;
          },
        })
      )
    );
    const failed = {
      event: {
        id: "side-chat-failed",
        displayText: "retry in side chat",
        displayStatus: "failed",
        result: { syntheticUserInput: true, deliveryStatus: "failed" },
      },
      chunk_id: "side-chat-failed",
    } as unknown as OptimizedChatItem;

    await act(async () => {
      await editUserMessage?.(failed, "retry in side chat");
    });

    expect(submitUserIntentSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "osagent-side-chat" })
    );
    expect(removeByIdPrefixSpy).toHaveBeenCalledWith(
      "side-chat-failed",
      "osagent-side-chat"
    );
  });
});

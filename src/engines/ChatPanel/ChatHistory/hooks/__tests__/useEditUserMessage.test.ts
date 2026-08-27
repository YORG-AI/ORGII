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

import type { OptimizedChatItem } from "../../chatItemPipeline/types";
import { useEditUserMessage } from "../useEditUserMessage";

const { submitUserIntentSpy, storeSessionId } = vi.hoisted(() => ({
  submitUserIntentSpy: vi.fn(async (..._args: unknown[]) => undefined),
  storeSessionId: { current: "osagent-session-1" },
}));

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useSetAtom: () => vi.fn(),
  useStore: () => ({ get: () => storeSessionId.current }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@src/api/tauri/agent", () => ({
  checkSnapshotChanges: vi.fn(async () => false),
  truncateAfterMessage: vi.fn(async () => undefined),
}));

vi.mock("@src/components/Message", () => ({
  default: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
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
    truncateBeforeId: vi.fn(async () => undefined),
    evictSession: vi.fn(async () => undefined),
  },
}));

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

function Harness({ onReady }: { onReady: (fn: EditUserMessageFn) => void }) {
  const editUserMessage = useEditUserMessage();
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
    submitUserIntentSpy.mockClear();
    storeSessionId.current = "osagent-session-1";
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
});

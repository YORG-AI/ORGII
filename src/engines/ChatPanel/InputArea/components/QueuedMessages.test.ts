// @vitest-environment jsdom
import { act, createElement } from "react";
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

import type { QueuedMessage } from "@src/store/ui/messageQueueAtom";

import QueuedMessages from "./QueuedMessages";

const { setEditTargetSpy } = vi.hoisted(() => ({
  setEditTargetSpy: vi.fn(),
}));

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useSetAtom: () => setEditTargetSpy,
  useAtomValue: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children?: unknown }) => children,
  closestCenter: vi.fn(),
}));

vi.mock("@dnd-kit/modifiers", () => ({
  restrictToParentElement: vi.fn(),
  restrictToVerticalAxis: vi.fn(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children?: unknown }) => children,
  verticalListSortingStrategy: vi.fn(),
}));

vi.mock("@src/lib/dndKit", () => ({
  useWebViewSensors: () => [],
}));

vi.mock("./ComposerStackHeader", () => ({
  default: () => null,
}));

vi.mock("./QueuedMessageItem", async () => {
  const ReactModule = await import("react");
  return {
    default: ({
      msg,
      onStartEdit,
    }: {
      msg: QueuedMessage;
      onStartEdit: (msg: QueuedMessage) => void;
    }) =>
      ReactModule.createElement(
        "button",
        { title: "start-edit", onClick: () => onStartEdit(msg) },
        msg.displayContent
      ),
  };
});

function queuedCanvasMessage(): QueuedMessage {
  return {
    id: "m1",
    turnIntentId: "tii-m1",
    sessionId: "osagent-1",
    // Agent projection: the internal contract text.
    content:
      "[Canvas Creation Request]\nCreate a new interactive inline Canvas for the user request below. Call render_inline_canvas exactly once for the finished Canvas.\n\n[User Request]\nbuild a timer",
    // Display projection: what the user typed (pill serialization).
    displayContent: "canvas [skill:/canvas] build a timer",
    priority: "next",
    status: "queued",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("QueuedMessages edit seeding", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    setEditTargetSpy.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("seeds the queue editor from displayContent, never the agent projection", () => {
    const msg = queuedCanvasMessage();
    act(() =>
      root.render(
        createElement(QueuedMessages, {
          messages: [msg],
          onCancel: vi.fn(),
          onSendNow: vi.fn(),
          onReorder: vi.fn(),
          onToggle: vi.fn(),
        })
      )
    );

    const editButton = container.querySelector<HTMLButtonElement>(
      'button[title="start-edit"]'
    );
    expect(editButton).not.toBeNull();

    act(() => editButton?.click());

    expect(setEditTargetSpy).toHaveBeenCalledWith({
      messageId: "m1",
      content: "canvas [skill:/canvas] build a timer",
      imageDataUrls: undefined,
    });
    const seeded = setEditTargetSpy.mock.calls[0]?.[0]?.content as string;
    expect(seeded).not.toContain("[Canvas Creation Request]");
  });
});

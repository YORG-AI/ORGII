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

import HumanSessionView from "./HumanSessionView";

const mocks = vi.hoisted(() => ({
  appendHumanSessionEntry: vi.fn(),
  getHumanSession: vi.fn(),
  loadSessions: vi.fn(),
  scrollToIndex: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 140,
    getVirtualItems: () =>
      Array.from({ length: Math.min(4, count) }, (_, index) => ({
        key: index,
        index,
        start: index * 140,
        end: (index + 1) * 140,
        size: 140,
        lane: 0,
      })),
    measureElement: vi.fn(),
    scrollToIndex: mocks.scrollToIndex,
  }),
}));

vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

vi.mock("@src/api/tauri/humanSession", () => ({
  appendHumanSessionEntry: mocks.appendHumanSessionEntry,
  getHumanSession: mocks.getHumanSession,
}));

vi.mock("@src/components/ComposerInput", async () => {
  const React = await import("react");
  const MockComposerInput = React.forwardRef<
    { setContent: (content: unknown) => void },
    { initialContent?: string }
  >(({ initialContent }, ref) => {
    React.useImperativeHandle(ref, () => ({ setContent: () => undefined }));
    return React.createElement(
      "div",
      { "data-testid": "human-session-entry-body" },
      initialContent
    );
  });
  MockComposerInput.displayName = "MockComposerInput";
  return { default: MockComposerInput };
});

vi.mock("@src/engines/ChatPanel/InputArea", () => ({
  default: () =>
    createElement("div", { "data-testid": "human-session-input-area" }),
}));

vi.mock("@src/engines/ChatPanel/InputArea/utils/pillContentParser", () => ({
  hasPillSyntax: () => false,
  parsePillTextToSnapshot: (body: string) => body,
}));

vi.mock("@src/store/session/sessionAtom/loaders", () => ({
  loadSessions: mocks.loadSessions,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("HumanSessionView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders notes with the shared Work-item activity timeline", async () => {
    const session = {
      sessionId: "humansession-1",
      title: "Release notes",
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:05:00.000Z",
      entries: [
        {
          id: "humanentry-1",
          body: "Prepared the release",
          createdAt: "2026-07-22T10:00:00.000Z",
        },
        {
          id: "humanentry-2",
          body: "Shared the changelog",
          createdAt: "2026-07-22T10:05:00.000Z",
        },
      ],
    };
    const request = Promise.resolve(session);
    mocks.getHumanSession.mockReturnValue(request);

    act(() => {
      root.render(
        createElement(HumanSessionView, {
          sessionId: session.sessionId,
        })
      );
    });
    await act(async () => {
      await request;
    });

    const cards = container.querySelectorAll(
      ".rounded-xl.border-border-1.bg-primary-container"
    );
    expect(cards).toHaveLength(2);
    expect(container.querySelectorAll("time")).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-testid="human-session-entry-body"]')
    ).toHaveLength(2);
    expect(
      container.querySelectorAll(".border-l.border-border-1")
    ).toHaveLength(1);
    expect(container.textContent).toContain("Prepared the release");
    expect(container.textContent).toContain("Shared the changelog");
    expect(
      container.querySelector('[data-testid="human-session-input-area"]')
    ).not.toBeNull();
  });

  it("mounts only the virtual row window for a long work log", async () => {
    const session = {
      sessionId: "humansession-long",
      title: "Long release log",
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T12:00:00.000Z",
      entries: Array.from({ length: 100 }, (_, index) => ({
        id: `humanentry-${index}`,
        body: `Entry ${index}`,
        createdAt: "2026-07-22T10:00:00.000Z",
      })),
    };
    const request = Promise.resolve(session);
    mocks.getHumanSession.mockReturnValue(request);

    act(() => {
      root.render(
        createElement(HumanSessionView, { sessionId: session.sessionId })
      );
    });
    await act(async () => {
      await request;
    });

    expect(
      container.querySelectorAll('[data-testid="human-session-entry-body"]')
    ).toHaveLength(4);
    expect(mocks.scrollToIndex).toHaveBeenCalledWith(99, { align: "end" });
  });
});

// @vitest-environment jsdom
import React, { act } from "react";
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

import type { TranscriptItem } from "../../lib/transcriptReducer";
import { ChatTranscript } from "./ChatTranscript";
import type { MobileFileTarget } from "./mobileFileTool";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./AgentBubble", () => ({
  AgentBubble: ({ text }: { text: string }) =>
    React.createElement("div", null, text),
}));

vi.mock("./UserBubble", () => ({
  UserBubble: ({ text }: { text: string }) =>
    React.createElement("div", null, text),
}));

vi.mock("@src/components/FileTypeIcon", () => ({
  default: ({ fileName }: { fileName: string }) =>
    React.createElement("span", { "data-file-icon": fileName }),
}));

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  observe = vi.fn();
  disconnect = vi.fn();

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const USER_ITEM: TranscriptItem = {
  id: "user-1",
  kind: "user",
  text: "First question",
};

describe("ChatTranscript tail follow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollHeight = 1_000;
  let clientHeight = 300;
  let scrollTop = 0;
  let nextFrameId = 1;
  let frameCallbacks = new Map<number, FrameRequestCallback>();
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    scrollHeight = 1_000;
    clientHeight = 300;
    scrollTop = 0;
    nextFrameId = 1;
    frameCallbacks = new Map();
    ResizeObserverStub.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      frameCallbacks.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (frameId: number) => {
      frameCallbacks.delete(frameId);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  const renderTranscript = async (
    items: TranscriptItem[],
    options: {
      sessionId?: string;
      roundId?: string;
      forceFollowKey?: string;
      waitingForAgent?: boolean;
      onOpenFile?: (eventId: string, target: MobileFileTarget) => Promise<void>;
    } = {}
  ) => {
    await act(async () => {
      root.render(
        React.createElement(ChatTranscript, {
          sessionId: options.sessionId ?? "session-1",
          roundId: options.roundId,
          items,
          phase: "ready",
          forceFollowKey: options.forceFollowKey,
          waitingForAgent: options.waitingForAgent,
          onOpenFile: options.onOpenFile,
          onRetry: vi.fn(),
        })
      );
    });
    const scrollRoot = container.querySelector<HTMLDivElement>("[role=log]");
    if (!scrollRoot) throw new Error("transcript scroll root did not render");
    Object.defineProperties(scrollRoot, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    return scrollRoot;
  };

  const flushFrames = () => {
    act(() => {
      const callbacks = [...frameCallbacks.values()];
      frameCallbacks.clear();
      callbacks.forEach((callback) => callback(performance.now()));
    });
  };

  it("follows appended and streaming content while the reader is at the bottom", async () => {
    await renderTranscript([USER_ITEM]);
    const agentItem: TranscriptItem = {
      id: "agent-1",
      kind: "agent",
      text: "Working",
      streaming: true,
    };

    await renderTranscript([USER_ITEM, agentItem]);
    expect(scrollTop).toBe(700);

    scrollHeight = 1_200;
    await renderTranscript([
      USER_ITEM,
      { ...agentItem, text: "Working with a longer streamed answer" },
    ]);
    expect(scrollTop).toBe(900);
  });

  it("fills the transcript area and labels initial history loading", async () => {
    vi.useFakeTimers();

    await act(async () => {
      root.render(
        React.createElement(ChatTranscript, {
          sessionId: "session-1",
          items: [],
          phase: "loading",
          onRetry: vi.fn(),
        })
      );
    });

    const loading = container.querySelector(
      '[data-mobile-transcript-loading="true"]'
    );
    expect(loading).not.toBeNull();
    expect(loading?.classList.contains("flex-1")).toBe(true);
    expect(loading?.classList.contains("min-h-0")).toBe(true);
    expect(loading?.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(container.textContent).toContain("transcript.loading");
  });

  it("shows the shared ChatPanel loading block while waiting for first Agent output", async () => {
    await renderTranscript(
      [
        USER_ITEM,
        {
          id: "mobile-user-turn-2",
          kind: "user",
          text: "New local question",
          optimistic: true,
          turnIntentId: "turn-2",
        },
      ],
      { forceFollowKey: "turn-2", waitingForAgent: true }
    );

    expect(
      container.querySelector('[data-mobile-agent-loading="true"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="chat-loading-block"]')
    ).not.toBeNull();

    await renderTranscript(
      [
        USER_ITEM,
        {
          id: "agent-turn-2",
          kind: "agent",
          text: "Working",
          streaming: true,
        },
      ],
      { forceFollowKey: "turn-2", waitingForAgent: false }
    );

    expect(
      container.querySelector('[data-mobile-agent-loading="true"]')
    ).toBeNull();
  });

  it("does not steal the viewport after the reader scrolls up", async () => {
    const scrollRoot = await renderTranscript([USER_ITEM]);
    await renderTranscript([
      USER_ITEM,
      { id: "agent-1", kind: "agent", text: "Existing answer" },
    ]);
    scrollTop = 100;
    scrollRoot.dispatchEvent(new Event("scroll"));
    ResizeObserverStub.instances.forEach((observer) => observer.trigger());
    expect(scrollTop).toBe(100);
    flushFrames();

    scrollHeight = 1_200;
    await renderTranscript([
      USER_ITEM,
      { id: "agent-1", kind: "agent", text: "A longer existing answer" },
    ]);

    expect(scrollTop).toBe(100);
    const scrollButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="transcript.scrollToBottom"]'
    );
    expect(scrollButton).not.toBeNull();

    act(() => scrollButton?.click());
    expect(scrollTop).toBe(900);
  });

  it("resumes following after the reader returns near the bottom", async () => {
    const scrollRoot = await renderTranscript([USER_ITEM]);
    scrollTop = 100;
    scrollRoot.dispatchEvent(new Event("scroll"));
    flushFrames();

    scrollTop = 670;
    scrollRoot.dispatchEvent(new Event("scroll"));
    flushFrames();

    scrollHeight = 1_200;
    await renderTranscript([
      USER_ITEM,
      { id: "agent-1", kind: "agent", text: "New answer" },
    ]);
    expect(scrollTop).toBe(900);
  });

  it("forces the new local turn into view and resets follow on session switch", async () => {
    const scrollRoot = await renderTranscript([USER_ITEM]);
    scrollTop = 100;
    scrollRoot.dispatchEvent(new Event("scroll"));
    flushFrames();

    scrollHeight = 1_300;
    await renderTranscript(
      [
        USER_ITEM,
        {
          id: "mobile-user-turn-2",
          kind: "user",
          text: "New local question",
          optimistic: true,
          turnIntentId: "turn-2",
        },
      ],
      { forceFollowKey: "turn-2" }
    );
    expect(scrollTop).toBe(1_000);

    scrollTop = 120;
    scrollRoot.dispatchEvent(new Event("scroll"));
    flushFrames();
    scrollHeight = 900;
    await renderTranscript(
      [{ id: "session-2-user", kind: "user", text: "Other session" }],
      { sessionId: "session-2" }
    );
    expect(scrollTop).toBe(600);
  });

  it("resets follow when the selected round changes in the same session", async () => {
    const scrollRoot = await renderTranscript([USER_ITEM], { roundId: "r3" });
    scrollTop = 100;
    scrollRoot.dispatchEvent(new Event("scroll"));
    flushFrames();

    scrollHeight = 800;
    await renderTranscript(
      [{ id: "old-round-user", kind: "user", text: "Earlier question" }],
      { roundId: "r1" }
    );
    expect(scrollTop).toBe(500);
  });

  it("routes structured tools through the compact mobile tool renderer", async () => {
    const onOpenFile = vi.fn(() => Promise.resolve());
    await renderTranscript(
      [
        USER_ITEM,
        {
          id: "tool-read-1",
          kind: "tool",
          text: "read_file",
          toolName: "read_file",
          toolCanonical: "read_file",
          toolStatus: "completed",
          toolSummary: "/repo/src/session.ts",
          toolData: {
            kind: "file",
            filePath: "/repo/src/session.ts",
            fileName: "session.ts",
            language: "typescript",
            lineCount: 42,
          },
        },
      ],
      { roundId: "round-1", onOpenFile }
    );

    const tool = container.querySelector<HTMLElement>(
      '[data-tool-call-name="read_file"]'
    );
    const toolItem = container.querySelector<HTMLElement>(
      '[data-transcript-item-kind="tool"]'
    );
    expect(tool).not.toBeNull();
    expect(toolItem?.classList.contains("py-0.5")).toBe(true);
    expect(toolItem?.classList.contains("px-2")).toBe(true);
    expect(tool?.textContent).toContain("transcript.tools.labels.readFile");
    expect(tool?.textContent).toContain("/repo/src/session.ts");
    expect(tool?.textContent).not.toBe("read_file");
    expect(tool?.querySelector("details")).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      (tool as HTMLButtonElement).click();
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(
      dialog?.querySelector('[data-mobile-tool-detail="tool-read-1"]')
    ).not.toBeNull();
    expect(dialog?.textContent).toContain("session.ts");
    expect(dialog?.textContent).not.toContain('"lineCount": 42');
    expect(tool?.getAttribute("aria-expanded")).toBe("true");
    expect(toolItem?.textContent).not.toContain('"lineCount": 42');

    const openFile = dialog?.querySelector<HTMLButtonElement>(
      '[data-mobile-open-file="/repo/src/session.ts"]'
    );
    expect(openFile).not.toBeNull();
    await act(async () => {
      openFile?.click();
      await Promise.resolve();
    });
    expect(onOpenFile).toHaveBeenCalledWith(
      "tool-read-1",
      expect.objectContaining({
        targetIndex: 0,
        filePath: "/repo/src/session.ts",
      })
    );

    await renderTranscript(
      [
        USER_ITEM,
        {
          id: "tool-read-1",
          kind: "tool",
          text: "read_file",
          toolName: "read_file",
          toolCanonical: "read_file",
          toolStatus: "completed",
          toolSummary: "/repo/src/session.ts",
          toolData: {
            kind: "file",
            filePath: "/repo/src/session.ts",
            fileName: "session.ts",
            language: "typescript",
            lineCount: 84,
          },
        },
      ],
      { roundId: "round-1", onOpenFile }
    );

    expect(
      document.body.querySelector('[role="dialog"]')?.textContent
    ).toContain("session.ts");
    expect(
      document.body.querySelector('[role="dialog"]')?.textContent
    ).not.toContain('"lineCount": 84');
  });
});

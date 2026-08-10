// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ChatSessionTabRenderer from "./chatSession";

const receivedTargets: Array<string | undefined> = [];

vi.mock("@src/engines/ChatPanel/ChatView", () => ({
  default: ({ initialMessageId }: { initialMessageId?: string }) => {
    receivedTargets.push(initialMessageId);
    return <div data-testid="chat-view-target">{initialMessageId}</div>;
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatSessionTabRenderer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    receivedTargets.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("reacts when an existing keyed tab receives a new exact message target", async () => {
    const render = (initialMessageId?: string) =>
      root.render(
        <ChatSessionTabRenderer
          paneId="mainPane"
          isActive
          tab={{
            id: "chat-session:session-1",
            type: "chat-session",
            title: "Session",
            data: { sessionId: "session-1", initialMessageId },
          }}
        />
      );

    await act(async () => render("parent-anchor-1"));
    await act(async () => render("parent-anchor-2"));

    expect(receivedTargets).toEqual(["parent-anchor-1", "parent-anchor-2"]);
    expect(container.textContent).toBe("parent-anchor-2");
  });
});

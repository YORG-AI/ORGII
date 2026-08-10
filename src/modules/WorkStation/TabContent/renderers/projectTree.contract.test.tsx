// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { workstationLayoutAtom } from "@src/store/workstation/tabs";

import ProjectTreeTabRenderer from "./projectTree";

vi.mock("@src/modules/ProjectManager/ProjectJourney", () => ({
  ProjectTreePage: ({
    onOpenSession,
    onOpenSessionJourney,
  }: {
    onOpenSession: (sessionId: string, title: string) => void;
    onOpenSessionJourney: (
      sessionId: string,
      title: string,
      target?: { taskId?: string; forkId?: string; anchorMessageId?: string }
    ) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="open-chat"
        onClick={() => onOpenSession("session-exact", "Exact session")}
      >
        Open chat
      </button>
      <button
        type="button"
        data-testid="open-fork-journey"
        onClick={() =>
          onOpenSessionJourney("session-exact", "fork-1", {
            forkId: "fork-1",
            anchorMessageId: "message-9",
          })
        }
      >
        Open fork Journey
      </button>
      <button
        type="button"
        data-testid="open-session-journey"
        onClick={() => onOpenSessionJourney("session-exact", "Exact session")}
      >
        Open Session Journey
      </button>
    </div>
  ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectTreeTabRenderer session Journey contract", () => {
  let container: HTMLDivElement;
  let root: Root;
  const store = createStore();

  beforeEach(() => {
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [], activeTabId: null },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens distinct chat and Session Journey tabs using the exact session anchor", async () => {
    await act(async () => {
      root.render(
        <Provider store={store}>
          <ProjectTreeTabRenderer
            tab={{} as never}
            paneId="mainPane"
            isActive
          />
        </Provider>
      );
    });

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="open-chat"]'
        ) as HTMLButtonElement
      ).click();
      (
        container.querySelector(
          '[data-testid="open-session-journey"]'
        ) as HTMLButtonElement
      ).click();
      (
        container.querySelector(
          '[data-testid="open-fork-journey"]'
        ) as HTMLButtonElement
      ).click();
    });

    const tabs = store.get(workstationLayoutAtom).mainPane.tabs;
    expect(tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "chat-session",
          data: { sessionId: "session-exact", title: "Exact session" },
        }),
        expect.objectContaining({
          type: "session-journey",
          data: {
            sessionId: "session-exact",
            sessionName: "fork-1",
            selectedForkId: "fork-1",
            selectedAnchorMessageId: "message-9",
          },
        }),
      ])
    );
  });
});

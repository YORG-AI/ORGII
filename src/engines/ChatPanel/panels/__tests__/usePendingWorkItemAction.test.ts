// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
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

import {
  pendingChatPanelWorkItemActionAtom,
  requestChatPanelWorkItemActionAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";

import { usePendingWorkItemAction } from "../usePendingWorkItemAction";

function Harness({
  workItemShortId,
  onStartAgent,
}: {
  workItemShortId: string;
  onStartAgent: () => void;
}) {
  usePendingWorkItemAction({ workItemShortId, onStartAgent });
  return null;
}

describe("usePendingWorkItemAction", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
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

  it("starts once after the canonical Work Item surface claims the request", () => {
    const store = createStore();
    const onStartAgent = vi.fn();
    store.set(requestChatPanelWorkItemActionAtom, {
      workItemShortId: "ORG-42",
      action: "start_agent",
    });

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Harness, {
            workItemShortId: "ORG-42",
            onStartAgent,
          })
        )
      );
    });

    expect(onStartAgent).toHaveBeenCalledTimes(1);
    expect(store.get(pendingChatPanelWorkItemActionAtom)).toBeNull();

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Harness, {
            workItemShortId: "ORG-42",
            onStartAgent,
          })
        )
      );
    });
    expect(onStartAgent).toHaveBeenCalledTimes(1);
  });

  it("leaves a request pending for its owning Work Item", () => {
    const store = createStore();
    const onStartAgent = vi.fn();
    const request = store.set(requestChatPanelWorkItemActionAtom, {
      workItemShortId: "ORG-42",
      action: "start_agent",
    });

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Harness, {
            workItemShortId: "ORG-43",
            onStartAgent,
          })
        )
      );
    });

    expect(onStartAgent).not.toHaveBeenCalled();
    expect(store.get(pendingChatPanelWorkItemActionAtom)).toEqual(request);
  });
});

// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

import {
  collapseAllCommandAtom,
  setAllBlocksCollapsedAtom,
} from "@src/store/ui/collapseStateAtom";

import {
  ChatCollapseScope,
  getSubagentCollapseScope,
} from "./ChatCollapseScope";
import { useEventBlockHeader } from "./blocks/primitives/useEventBlockHeader";

it("isolates real block consumers in two subagent panes from each other and the parent", () => {
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const store = createStore();
  const a = getSubagentCollapseScope("collapse-test-a");
  const b = getSubagentCollapseScope("collapse-test-b");
  const host = document.createElement("div");
  const root = createRoot(host);
  function Block({ name }: { name: string }) {
    const state = useEventBlockHeader({
      eventId: "same-event-id",
      collapseAllValue: true,
    });
    return createElement(
      "span",
      { "data-name": name },
      String(state.isCollapsed)
    );
  }
  const content = () =>
    createElement(
      Provider,
      { store },
      createElement(Block, { name: "parent" }),
      createElement(
        ChatCollapseScope.Provider,
        { value: a },
        createElement(Block, { name: "a" })
      ),
      createElement(
        ChatCollapseScope.Provider,
        { value: b },
        createElement(Block, { name: "b" })
      )
    );
  try {
    act(() => root.render(content()));
    act(() => store.set(a.setAllBlocksCollapsedAtom, true));
    expect(host.textContent).toBe("falsetruefalse");
    expect(store.get(collapseAllCommandAtom).epoch).toBe(0);
    act(() => store.set(setAllBlocksCollapsedAtom, true));
    expect(host.textContent).toBe("truetruefalse");
    store.set(b.setTurnCollapseOverrideAtom, {
      turnId: "turn",
      collapsed: false,
    });
    act(() => store.set(a.setAllBlocksCollapsedAtom, false));
    expect(host.textContent).toBe("truefalsefalse");
    expect(store.get(b.turnCollapseOverrideAtom).get("turn")).toBe(false);
    expect(getSubagentCollapseScope("collapse-test-a")).toBe(a);
  } finally {
    act(() => root.unmount());
    delete environment.IS_REACT_ACT_ENVIRONMENT;
  }
});

it("bounds dormant session scopes while retaining recently revisited state", () => {
  const oldest = getSubagentCollapseScope("oldest");
  const recent = getSubagentCollapseScope("recent");
  for (let i = 0; i < 205; i++) {
    getSubagentCollapseScope(`bounded-${i}`);
    expect(getSubagentCollapseScope("recent")).toBe(recent);
  }
  expect(getSubagentCollapseScope("oldest")).not.toBe(oldest);
});

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
} from "vitest";

import {
  clearTabViewStates,
  getTabViewState,
} from "@src/store/workstation/tabs/tabViewState";

import { useTabViewState } from "./useTabViewState";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type Setter = (next: number | ((previous: number) => number)) => void;

interface ProbeProps {
  tabId: string;
  slot: string;
  /** Receives the setter after each commit so tests can drive updates. */
  onSetter: (setter: Setter) => void;
}

function Probe({ tabId, slot, onSetter }: ProbeProps) {
  const [value, setValue] = useTabViewState<number>(tabId, slot, 0);
  useEffect(() => {
    onSetter(setValue);
  }, [onSetter, setValue]);
  return createElement("span", null, String(value));
}

describe("useTabViewState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let setter: Setter | null;
  const onSetter = (next: Setter) => {
    setter = next;
  };

  const render = (tabId: string, slot = "count") =>
    act(() => {
      root.render(createElement(Probe, { tabId, slot, onSetter }));
    });
  const update = (next: number | ((previous: number) => number)) =>
    act(() => setter?.(next));

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    clearTabViewStates();
    setter = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("survives the component being unmounted and rebuilt for the same tab", () => {
    render("tab:1");
    expect(container.textContent).toBe("0");

    update(5);
    expect(container.textContent).toBe("5");
    expect(getTabViewState("tab:1", "count")).toBe(5);

    // Tab switch: the renderer goes away entirely…
    act(() => root.unmount());
    root = createRoot(container);
    // …and comes back rebuilt from the store, not from a hidden DOM tree.
    render("tab:1");
    expect(container.textContent).toBe("5");
  });

  it("supports functional updates", () => {
    render("tab:1");
    update((previous) => previous + 2);
    update((previous) => previous + 2);
    expect(container.textContent).toBe("4");
    expect(getTabViewState("tab:1", "count")).toBe(4);
  });

  it("re-reads when the mounted renderer is handed a different tab", () => {
    render("tab:1");
    update(3);

    render("tab:2");
    expect(container.textContent).toBe("0");
    update(9);

    render("tab:1");
    expect(container.textContent).toBe("3");
    expect(getTabViewState("tab:2", "count")).toBe(9);
  });

  it("persists nothing for an empty tab id", () => {
    render("");
    update(7);
    expect(container.textContent).toBe("7");
    expect(getTabViewState("", "count")).toBeUndefined();
  });
});

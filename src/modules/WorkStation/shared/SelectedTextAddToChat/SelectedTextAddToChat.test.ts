// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
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

import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";

import { SelectedTextAddToChat } from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "selectionMenu.addToChat" ? "Add to Chat" : key,
  }),
}));

describe("SelectedTextAddToChat", () => {
  let container: HTMLDivElement;
  let root: Root;
  const store = createStore();
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    store.set(addToAgentAtom, null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.getSelection()?.removeAllRanges();
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderSurface({
    displayName = "example.ts",
    enabled = true,
    scopeKey = "scope-a",
  }: {
    displayName?: string;
    enabled?: boolean;
    scopeKey?: string;
  } = {}): void {
    act(() => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(
            SelectedTextAddToChat,
            { displayName, enabled, scopeKey },
            React.createElement("span", { id: "first" }, "const first = 1;"),
            React.createElement("span", { id: "second" }, "const second = 2;")
          )
        )
      );
    });
  }

  async function selectText(elementId: string): Promise<void> {
    const target = container.querySelector(`#${elementId}`);
    const selection = window.getSelection();
    if (!target || !selection) throw new Error("Selection fixture unavailable");

    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);

    await act(async () => {
      target.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          clientX: 40,
          clientY: 60,
        })
      );
      await vi.advanceTimersByTimeAsync(100);
    });
  }

  function clickAddToChat(): void {
    const menuItem = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".text-selection-dropdown .cursor-pointer"
      )
    ).find((element) => element.textContent?.trim() === "Add to Chat");

    expect(menuItem).toBeDefined();
    act(() => menuItem?.click());
  }

  it("adds selected DOM text to chat with the owning surface label", async () => {
    renderSurface();
    await selectText("first");

    expect(
      document.querySelector(".text-selection-dropdown")?.textContent
    ).toContain("Add to Chat");

    clickAddToChat();

    expect(store.get(addToAgentAtom)).toEqual({
      type: "terminal",
      text: "const first = 1;",
      displayName: "example.ts",
    });
  });

  it("does not let a closing timer erase a newer selection", async () => {
    renderSurface();
    await selectText("first");
    clickAddToChat();
    store.set(addToAgentAtom, null);

    await selectText("second");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    clickAddToChat();

    expect(store.get(addToAgentAtom)).toEqual({
      type: "terminal",
      text: "const second = 2;",
      displayName: "example.ts",
    });
  });

  it("does not install selection behavior while disabled", async () => {
    renderSurface({ enabled: false });
    await selectText("first");

    expect(document.querySelector(".text-selection-dropdown")).toBeNull();
    expect(store.get(addToAgentAtom)).toBeNull();

    renderSurface({ enabled: true });
    await selectText("first");
    expect(document.querySelector(".text-selection-dropdown")).not.toBeNull();
  });

  it("ignores a selection owned by another surface", async () => {
    renderSurface();
    const outside = document.createElement("span");
    outside.textContent = "outside selection";
    document.body.appendChild(outside);
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(outside);
    selection?.removeAllRanges();
    selection?.addRange(range);

    await act(async () => {
      container
        .querySelector("#first")
        ?.dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, clientX: 40, clientY: 60 })
        );
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(document.querySelector(".text-selection-dropdown")).toBeNull();
    expect(store.get(addToAgentAtom)).toBeNull();
    outside.remove();
  });

  it("dismisses the active selection menu with Escape", async () => {
    renderSurface();
    await selectText("first");
    expect(document.querySelector(".text-selection-dropdown")).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(document.querySelector(".text-selection-dropdown")).toBeNull();
    expect(store.get(addToAgentAtom)).toBeNull();
  });

  it("dismisses the active selection menu on outside click", async () => {
    renderSurface();
    await selectText("first");
    expect(document.querySelector(".text-selection-dropdown")).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
    });

    expect(document.querySelector(".text-selection-dropdown")).toBeNull();
    expect(store.get(addToAgentAtom)).toBeNull();
  });

  it("resets only selection state when the owning scope changes", async () => {
    renderSurface({ displayName: "first.ts", scopeKey: "scope-a" });
    const childBeforeScopeChange = container.querySelector("#first");
    await selectText("first");
    expect(document.querySelector(".text-selection-dropdown")).not.toBeNull();

    renderSurface({ displayName: "second.ts", scopeKey: "scope-b" });

    expect(container.querySelector("#first")).toBe(childBeforeScopeChange);
    expect(document.querySelector(".text-selection-dropdown")).toBeNull();

    await selectText("second");
    clickAddToChat();
    expect(store.get(addToAgentAtom)).toEqual({
      type: "terminal",
      text: "const second = 2;",
      displayName: "second.ts",
    });
  });
});

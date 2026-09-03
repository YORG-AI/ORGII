// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { kanbanSearchQueryAtom } from "@src/store/ui/kanbanViewStateAtom";

import KanbanSearchInput from "./KanbanSearchInput";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("KanbanSearchInput", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    store = createStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderSearch(): void {
    act(() => {
      root.render(
        createElement(Provider, { store }, createElement(KanbanSearchInput))
      );
    });
  }

  it("starts as a search button and autofocuses the expanded input", () => {
    renderSearch();

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="kanban-search-trigger"]'
    );
    expect(trigger).not.toBeNull();
    expect(container.querySelector("input")).toBeNull();

    act(() => trigger?.click());

    const input = container.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    const closeButton = container.querySelector<HTMLButtonElement>(
      'button[title="tooltips.closeEsc"]'
    );
    expect(closeButton).not.toBeNull();

    act(() => closeButton?.click());

    expect(container.querySelector("input")).toBeNull();
    expect(
      container.querySelector('[data-testid="kanban-search-trigger"]')
    ).not.toBeNull();
  });

  it("keeps an active query visible and focused", () => {
    store.set(kanbanSearchQueryAtom, "active session");
    renderSearch();

    const input = container.querySelector<HTMLInputElement>("input");
    expect(input?.value).toBe("active session");
    expect(document.activeElement).toBe(input);
    expect(
      container.querySelector('[data-testid="kanban-search-trigger"]')
    ).toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[title="tooltips.closeEsc"]')
        ?.click();
    });

    expect(store.get(kanbanSearchQueryAtom)).toBe("");
    expect(container.querySelector("input")).toBeNull();
  });
});

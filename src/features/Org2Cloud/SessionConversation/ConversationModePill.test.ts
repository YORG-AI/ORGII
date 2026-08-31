// @vitest-environment jsdom
import i18n from "i18next";
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";

import { ConversationModePill } from "./ConversationModePill";
import { conversationComposerModeAtomFamily } from "./conversationComposerMode";

const comments = vi.hoisted(() => ({ available: true }));

vi.mock("../SessionComments/SessionCommentsContext", () => ({
  useSessionCommentsContext: () => (comments.available ? { target: {} } : null),
}));

const SESSION_ID = "conversation-mode-pill-test";
let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  comments.available = true;
  store = createStore();
  store.set(chatPanelMaximizedAtom, false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPill(sessionId: string | null = SESSION_ID): void {
  act(() => {
    root.render(
      createElement(
        Provider,
        { store },
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ConversationModePill, { sessionId })
        )
      )
    );
  });
}

function button(label: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  );
  expect(element).not.toBeNull();
  return element!;
}

function hover(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  act(() => vi.advanceTimersByTime(250));
}

describe("ConversationModePill", () => {
  it("shows accessible icon choices in the non-maximized pane", () => {
    renderPill();

    expect(
      button("Agent").querySelector('[data-icon="infinity"]')
    ).not.toBeNull();
    expect(
      button("Team chat").querySelector('[data-icon="messages-square"]')
    ).not.toBeNull();
    expect(button("Agent").textContent).toBe("");
    expect(button("Team chat").textContent).toBe("");
    expect(button("Agent").getAttribute("aria-pressed")).toBe("true");
    expect(button("Team chat").getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps mode selection session-scoped and stable when clicking the selected choice", () => {
    renderPill();
    const modeAtom = conversationComposerModeAtomFamily(SESSION_ID);

    act(() => button("Team chat").click());
    expect(store.get(modeAtom)).toBe("team_chat");
    expect(button("Team chat").getAttribute("aria-pressed")).toBe("true");
    expect(store.get(conversationComposerModeAtomFamily("other-session"))).toBe(
      "prompt"
    );

    act(() => button("Team chat").click());
    expect(store.get(modeAtom)).toBe("team_chat");

    act(() => button("Agent").click());
    expect(store.get(modeAtom)).toBe("prompt");
  });

  it("keeps both choices icon-only when maximized without resetting the mode", () => {
    renderPill();
    const teamButton = button("Team chat");
    act(() => teamButton.click());

    act(() => store.set(chatPanelMaximizedAtom, true));
    expect(button("Agent").textContent).toBe("");
    expect(button("Team chat").textContent).toBe("");
    expect(
      button("Agent").querySelector('[data-icon="infinity"]')
    ).not.toBeNull();
    expect(
      button("Team chat").querySelector('[data-icon="messages-square"]')
    ).not.toBeNull();
    expect(button("Team chat")).toBe(teamButton);
    expect(teamButton.getAttribute("aria-pressed")).toBe("true");

    act(() => store.set(chatPanelMaximizedAtom, false));
    expect(button("Team chat")).toBe(teamButton);
    expect(teamButton.textContent).toBe("");
    expect(store.get(conversationComposerModeAtomFamily(SESSION_ID))).toBe(
      "team_chat"
    );
  });

  it.each([
    ["Agent", "Send to the agent"],
    ["Team chat", "Message teammates — does not prompt the agent"],
  ])(
    "explains %s with the shared tooltip and dismisses it on selection",
    (label, explanation) => {
      renderPill();
      hover(button(label));

      const tooltip = document.querySelector(".native-tooltip-framed-panel");
      expect(tooltip?.textContent).toBe(explanation);
      expect(tooltip?.querySelector("kbd")).toBeNull();

      act(() => button(label).click());
      expect(document.querySelector(".native-tooltip")).toBeNull();
    }
  );

  it.each(["no-session", "no-discussion"])(
    "hides the switch for %s",
    (reason) => {
      comments.available = reason !== "no-discussion";
      renderPill(reason === "no-session" ? null : SESSION_ID);

      expect(container.querySelector("button")).toBeNull();
      expect(document.querySelector(".native-tooltip")).toBeNull();
    }
  );

  it("does no idle tooltip work and cleans up after repeated open/unmount cycles", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const layoutEvents = new Set(["scroll", "resize"]);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      addListener.mockClear();
      removeListener.mockClear();
      renderPill();
      expect(vi.getTimerCount()).toBe(0);
      expect(
        addListener.mock.calls.filter(([event]) => layoutEvents.has(event))
      ).toHaveLength(0);

      hover(button("Agent"));
      const listeners = addListener.mock.calls.filter(([event]) =>
        layoutEvents.has(event)
      );
      expect(listeners.map(([event]) => event).sort()).toEqual([
        "resize",
        "scroll",
      ]);

      act(() => {
        button("Agent").dispatchEvent(
          new MouseEvent("mouseout", { bubbles: true })
        );
        root.render(null);
      });

      expect(document.querySelector(".native-tooltip")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      for (const listener of listeners) {
        expect(removeListener).toHaveBeenCalledWith(...listener);
      }
    }
  });
});

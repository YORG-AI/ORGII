// @vitest-environment jsdom
import { Provider } from "jotai";
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
  openOrReplaceSessionInChatPanelTabAtom,
  openSessionInNewChatTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import { SessionHistoryNav, type SessionHistoryNavVariant } from "./index";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("SessionHistoryNav", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createInstrumentedStore>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    resetInstrumentedStore();
    localStorage.clear();
    store = createInstrumentedStore();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetInstrumentedStore();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function render(variant: SessionHistoryNavVariant): void {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(SessionHistoryNav, { variant })
        )
      );
    });
  }

  function button(testId: string): HTMLButtonElement {
    const element = container.querySelector(`[data-testid="${testId}"]`);
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`${testId} did not render as a button`);
    }
    return element;
  }

  // The tabs atom re-reads its storage when first mounted and reseeds a fresh
  // Launchpad, so state must be written after the component subscribes.
  function openSession(sessionId: string, fresh = false): void {
    act(() => {
      store.set(
        fresh
          ? openSessionInNewChatTabAtom
          : openOrReplaceSessionInChatPanelTabAtom,
        { sessionId }
      );
    });
  }

  it.each<SessionHistoryNavVariant>(["sidebar", "tabBar"])(
    "renders both arrows disabled on a fresh tab (%s)",
    (variant) => {
      render(variant);
      openSession("session-a", true);

      expect(
        container.querySelector(
          `[data-testid="session-history-nav-${variant}"]`
        )
      ).not.toBeNull();
      expect(button("session-history-nav-back").disabled).toBe(true);
      expect(button("session-history-nav-forward").disabled).toBe(true);
    }
  );

  it("enables Back after an in-place hop and walks the trail on click", () => {
    render("sidebar");
    openSession("session-a", true);
    openSession("session-b");

    expect(button("session-history-nav-back").disabled).toBe(false);
    expect(button("session-history-nav-forward").disabled).toBe(true);

    act(() => button("session-history-nav-back").click());

    expect(store.get(activeSessionIdAtom)).toBe("session-a");
    expect(button("session-history-nav-back").disabled).toBe(true);
    expect(button("session-history-nav-forward").disabled).toBe(false);

    act(() => button("session-history-nav-forward").click());

    expect(store.get(activeSessionIdAtom)).toBe("session-b");
  });
});

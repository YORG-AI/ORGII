// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseBrowserStateReturn } from "./hooks/useBrowserState";
import {
  BrowserCore,
  MAX_RETAINED_BROWSER_WEBVIEWS,
  selectRetainedBrowserSessionIds,
} from "./index";
import type { BrowserSession } from "./types";

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtomValue: () => false,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./BrowserSessionWebview", () => ({
  default: ({
    session,
    isActive,
  }: {
    session: BrowserSession;
    isActive: boolean;
  }) =>
    createElement("div", {
      "data-browser-webview-session": session.id,
      "data-active": String(isActive),
    }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function session(
  id: string,
  url = `https://${id}.example.com`
): BrowserSession {
  return {
    id,
    title: id,
    url,
    history: url ? [url] : [],
    historyIndex: url ? 0 : -1,
    historyEntries: [],
    isLoading: false,
    error: null,
    incognito: false,
  };
}

function browserState(
  sessions: BrowserSession[],
  activeSessionId: string
): UseBrowserStateReturn {
  return {
    sessions,
    activeSessionId,
    activeSession: sessions.find((item) => item.id === activeSessionId),
    addSession: vi.fn(),
    closeSession: vi.fn(),
    setActiveSession: vi.fn(),
    updateSession: vi.fn(),
  };
}

describe("BrowserCore retained native WebViews", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(
      window as unknown as Record<string, unknown>,
      "__TAURI_INTERNALS__"
    );
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    vi.restoreAllMocks();
  });

  function renderWith(
    sessions: BrowserSession[],
    activeSessionId: string
  ): void {
    act(() => {
      root.render(
        createElement(BrowserCore, {
          browserState: browserState(sessions, activeSessionId),
        })
      );
    });
  }

  function mountedSessionIds(): string[] {
    return Array.from(
      container.querySelectorAll("[data-browser-webview-session]")
    ).map((element) => element.getAttribute("data-browser-webview-session")!);
  }

  it("keeps only the active and most recently active native WebViews mounted", () => {
    const sessions = [session("a"), session("b"), session("c")];

    renderWith(sessions, "a");
    expect(mountedSessionIds()).toEqual(["a"]);

    renderWith(sessions, "b");
    expect(mountedSessionIds()).toEqual(["a", "b"]);

    renderWith(sessions, "c");
    expect(mountedSessionIds()).toEqual(["b", "c"]);

    renderWith(sessions, "a");
    expect(mountedSessionIds()).toEqual(["a", "c"]);
    expect(mountedSessionIds()).toHaveLength(MAX_RETAINED_BROWSER_WEBVIEWS);
  });

  it("does not mount restored background sessions or blank tabs eagerly", () => {
    const sessions = [session("a"), session("blank", ""), session("c")];

    renderWith(sessions, "blank");
    expect(mountedSessionIds()).toEqual([]);

    renderWith(sessions, "c");
    expect(mountedSessionIds()).toEqual(["c"]);
  });

  it("keeps the native mount count bounded across repeated session switches", () => {
    const sessions = [session("a"), session("b"), session("c"), session("d")];

    for (let index = 0; index < 50; index += 1) {
      const activeSessionId = sessions[index % sessions.length].id;
      renderWith(sessions, activeSessionId);

      expect(mountedSessionIds()).toContain(activeSessionId);
      expect(mountedSessionIds().length).toBeLessThanOrEqual(
        MAX_RETAINED_BROWSER_WEBVIEWS
      );
    }
  });
});

describe("selectRetainedBrowserSessionIds", () => {
  it("drops deleted and non-navigable sessions while preserving recency", () => {
    expect(
      selectRetainedBrowserSessionIds(
        ["deleted", "a", "blank"],
        [session("a"), session("blank", ""), session("b")],
        "b"
      )
    ).toEqual(["a", "b"]);
  });
});

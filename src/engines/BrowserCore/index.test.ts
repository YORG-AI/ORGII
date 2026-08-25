// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { UseBrowserStateReturn } from "./hooks/useBrowserState";
import BrowserCore from "./index";
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

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: ({
    variant,
    placement,
    title,
    subtitle,
    fillParentHeight,
    children,
  }: {
    variant: string;
    placement: string;
    title: string;
    subtitle?: string;
    fillParentHeight?: boolean;
    children?: React.ReactNode;
  }) =>
    createElement(
      "div",
      {
        "data-placeholder-variant": variant,
        "data-placeholder-placement": placement,
        "data-fill-parent-height": String(fillParentHeight),
      },
      title,
      subtitle,
      children
    ),
}));

vi.mock("./BrowserSessionWebview", () => ({
  default: () => null,
}));

function createBrowserState(
  sessionOverrides: Partial<BrowserSession> = {}
): UseBrowserStateReturn {
  const session: BrowserSession = {
    id: "browser-session-1",
    url: "",
    title: "New Tab",
    history: [],
    historyIndex: -1,
    isLoading: false,
    error: null,
    ...sessionOverrides,
  };

  return {
    sessions: [session],
    activeSessionId: session.id,
    activeSession: session,
    addSession: vi.fn(),
    closeSession: vi.fn(),
    setActiveSession: vi.fn(),
    updateSession: vi.fn(),
  };
}

describe("BrowserCore blank tab placeholder", () => {
  it("uses the standard detail-panel placeholder without the TLS note", () => {
    const markup = renderToStaticMarkup(
      createElement(BrowserCore, {
        browserState: createBrowserState(),
      })
    );

    expect(markup).toContain('data-placeholder-variant="empty"');
    expect(markup).toContain('data-placeholder-placement="detail-panel"');
    expect(markup).toContain('data-fill-parent-height="true"');
    expect(markup).toContain("workstation.browserCore.enterUrlToStart");
    expect(markup).not.toContain("workstation.browserCore.tlsDevNote");
  });

  it("keeps private-browsing and replay context in the shared placeholder", () => {
    const markup = renderToStaticMarkup(
      createElement(BrowserCore, {
        browserState: createBrowserState({ incognito: true }),
        showSimulatorNotice: true,
      })
    );

    expect(markup).toContain(
      "workstation.browserCore.privateBrowsingEmptyTitle"
    );
    expect(markup).toContain("workstation.browserCore.simulatorBrowserNotice");
  });

  it("renders a caller-provided complete blank-tab placeholder", () => {
    const markup = renderToStaticMarkup(
      createElement(BrowserCore, {
        browserState: createBrowserState(),
        blankTabPlaceholder: createElement(
          "button",
          { type: "button" },
          "Open port 1998"
        ),
      })
    );

    expect(markup).toContain("Open port 1998");
    expect(markup).not.toContain("workstation.browserCore.enterUrlToStart");
  });

  it("keeps the shared workspace placeholder visible when it does not own webviews", () => {
    const markup = renderToStaticMarkup(
      createElement(BrowserCore, {
        browserState: createBrowserState(),
        blankTabPlaceholder: createElement(
          "button",
          { type: "button" },
          "Open port 1998"
        ),
        manageWebviews: false,
        respectModalBlocking: false,
      })
    );

    expect(markup).toContain("Open port 1998");
  });

  it("does not mount blank-tab options while hidden or after navigation", () => {
    const option = createElement(
      "button",
      { type: "button" },
      "Open port 1998"
    );
    const hiddenMarkup = renderToStaticMarkup(
      createElement(BrowserCore, {
        browserState: createBrowserState(),
        blankTabPlaceholder: option,
        hidden: true,
      })
    );
    const navigatedMarkup = renderToStaticMarkup(
      createElement(BrowserCore, {
        browserState: createBrowserState({ url: "http://localhost:1998/" }),
        blankTabPlaceholder: option,
      })
    );

    expect(hiddenMarkup).not.toContain("Open port 1998");
    expect(navigatedMarkup).not.toContain("Open port 1998");
  });
});

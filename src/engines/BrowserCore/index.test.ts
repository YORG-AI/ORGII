// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { webviewOverlayBlockedAtom } from "@src/store/ui/overlayAtom";
import { activeOverlayCountAtom } from "@src/store/ui/overlayLayerAtom";

import BrowserCore from "./index";
import type { BrowserState } from "./types";
import type { BrowserSession } from "./types";

/** Per-test atom reads; anything unlisted reads `false`. */
const atomValues = new Map<unknown, unknown>();

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtomValue: (atom: unknown) => atomValues.get(atom) ?? false,
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

// Keep this test compatible with the component-ownership relocation. Develop
// still reads Placeholder through the layouts barrel, while PRs that include
// the relocation import the component directly.
vi.mock("@src/components/Placeholder", () => ({
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

function withTauriRuntime<T>(render: () => T): T {
  const win = window as unknown as Record<string, unknown>;
  win.__TAURI_INTERNALS__ = {};
  try {
    return render();
  } finally {
    delete win.__TAURI_INTERNALS__;
  }
}

function createBrowserState(
  sessionOverrides: Partial<BrowserSession> = {}
): BrowserState {
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

describe("BrowserCore overlay-hidden notice", () => {
  afterEach(() => {
    atomValues.clear();
  });

  it("explains the blank pane while an overlay parks the webview offscreen", () => {
    atomValues.set(webviewOverlayBlockedAtom, true);

    const markup = withTauriRuntime(() =>
      renderToStaticMarkup(
        createElement(BrowserCore, {
          browserState: createBrowserState({ url: "http://localhost:1998/" }),
        })
      )
    );

    expect(markup).toContain("workstation.browserCore.webviewHiddenTitle");
    expect(markup).toContain("workstation.browserCore.webviewHiddenBody");
  });

  it("covers the macOS path where the webview is only sent behind React", () => {
    atomValues.set(activeOverlayCountAtom, 1);

    const markup = withTauriRuntime(() =>
      renderToStaticMarkup(
        createElement(BrowserCore, {
          browserState: createBrowserState({ url: "http://localhost:1998/" }),
        })
      )
    );

    expect(markup).toContain("workstation.browserCore.webviewHiddenTitle");
  });

  it("stays hidden when no overlay is open", () => {
    const markup = withTauriRuntime(() =>
      renderToStaticMarkup(
        createElement(BrowserCore, {
          browserState: createBrowserState({ url: "http://localhost:1998/" }),
        })
      )
    );

    expect(markup).not.toContain("workstation.browserCore.webviewHiddenTitle");
  });

  it("shows on the shared-runtime chrome that does not own the webview", () => {
    atomValues.set(activeOverlayCountAtom, 1);

    const markup = withTauriRuntime(() =>
      renderToStaticMarkup(
        createElement(BrowserCore, {
          browserState: createBrowserState({ url: "http://localhost:1998/" }),
          // SharedBrowserWorkspace -> WebViewport shape: visible chrome, but
          // SharedBrowserApp owns the native webview.
          respectModalBlocking: false,
          manageWebviews: false,
        })
      )
    );

    expect(markup).toContain("workstation.browserCore.webviewHiddenTitle");
  });

  it("stays hidden on blank tabs, host-hidden panes, and the owner host", () => {
    atomValues.set(webviewOverlayBlockedAtom, true);
    atomValues.set(activeOverlayCountAtom, 1);

    const blankUrlMarkup = withTauriRuntime(() =>
      renderToStaticMarkup(
        createElement(BrowserCore, {
          browserState: createBrowserState(),
        })
      )
    );
    const hostHiddenMarkup = withTauriRuntime(() =>
      renderToStaticMarkup(
        createElement(BrowserCore, {
          browserState: createBrowserState({ url: "http://localhost:1998/" }),
          hidden: true,
        })
      )
    );
    // SharedBrowserApp: aria-hidden owner host stacked over the same rect.
    const ownerHostMarkup = withTauriRuntime(() =>
      renderToStaticMarkup(
        createElement(BrowserCore, {
          browserState: createBrowserState({ url: "http://localhost:1998/" }),
          respectModalBlocking: false,
          bypassStationModeBlocking: true,
        })
      )
    );

    expect(blankUrlMarkup).not.toContain(
      "workstation.browserCore.webviewHiddenTitle"
    );
    expect(hostHiddenMarkup).not.toContain(
      "workstation.browserCore.webviewHiddenTitle"
    );
    expect(ownerHostMarkup).not.toContain(
      "workstation.browserCore.webviewHiddenTitle"
    );
  });
});

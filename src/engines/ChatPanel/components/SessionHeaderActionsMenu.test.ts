// @vitest-environment jsdom
import { type SVGProps, act, createElement, createRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalHistoryAppOpenPlan } from "@src/api/tauri/externalHistory/appOpen";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import {
  AppWindowMacIcon,
  ArrowUpRight01Icon,
  Copy01Icon,
  CursorInWindowIcon,
  ThirdBracketIcon,
} from "@src/icons";

import {
  SessionHeaderActionsMenu,
  type SessionHeaderActionsMenuProps,
} from "./SessionHeaderActionsMenu";

const mocks = vi.hoisted(() => ({
  session: { id: "session-a", name: "Session A", productMode: "chat" },
  eligible: true,
  copyReference: vi.fn(),
  openWindow: vi.fn(async () => undefined),
  appOpenPlan: vi.fn(),
  openInApp: vi.fn(),
  messageError: vi.fn(),
}));

vi.mock("@src/api/tauri/externalHistory/appOpen", () => ({
  externalHistoryAppOpenPlan: mocks.appOpenPlan,
  externalHistoryOpenInApp: mocks.openInApp,
}));
// Webpack loads SVGs as components; Vitest otherwise treats them as URLs.
vi.mock("@src/assets/modelIcons/claude.svg", () => ({
  default: (props: SVGProps<SVGSVGElement>) =>
    createElement("svg", { ...props, "data-brand": "claude" }),
}));
vi.mock("@src/assets/modelIcons/openai.svg", () => ({
  default: (props: SVGProps<SVGSVGElement>) =>
    createElement("svg", { ...props, "data-brand": "openai" }),
}));
vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: () => mocks.session,
  useSetAtom: () => mocks.openWindow,
}));
vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => "light",
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { app?: string }) =>
      key === "collaboration.openInApp.headerButton"
        ? `Open in ${options?.app}`
        : key,
  }),
}));
vi.mock("@src/store/session", () => ({
  sessionByIdAtom: vi.fn(),
  upsertSession: vi.fn(),
}));
vi.mock("@src/store/session/sessionTabPlacementAtom", () => ({
  openSessionInNewWindowAtom: {},
}));
vi.mock("@src/api/tauri/agent/session", () => ({
  trackSessionAsProject: vi.fn(),
}));
vi.mock("@src/components/Message", () => ({
  default: { success: vi.fn(), error: mocks.messageError },
}));
vi.mock("@src/features/Org2Cloud/useCopySessionReference", () => ({
  useCopySessionReference: () => ({
    isCopyReferenceEligible: () => mocks.eligible,
    handleCopyReference: mocks.copyReference,
    copyReferenceLabel: "Copy URL",
  }),
}));

let container: HTMLDivElement;
let root: Root;
let props: SessionHeaderActionsMenuProps;

function render(overrides: Partial<SessionHeaderActionsMenuProps> = {}) {
  props = { ...props, ...overrides };
  act(() => root.render(createElement(SessionHeaderActionsMenu, props)));
}

function element(testId: string): HTMLElement {
  const result = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`
  );
  expect(result, testId).not.toBeNull();
  return result!;
}

function click(testId: string) {
  act(() => element(testId).click());
}

function movePointer(from: HTMLElement | null, to: HTMLElement) {
  act(() => {
    from?.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: to })
    );
    to.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: from })
    );
  });
}

function submenuIds(): (string | null)[] {
  return [
    ...props.headerActionsDropdownRef.current!.querySelectorAll(
      '[aria-haspopup="menu"]'
    ),
  ].map((node) => node.getAttribute("data-testid"));
}

function key(keyValue: string) {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: keyValue,
        bubbles: true,
        cancelable: true,
      })
    );
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.eligible = true;
  mocks.appOpenPlan.mockResolvedValue(null);
  mocks.openInApp.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    activeSessionExists: true,
    copyEventJsonLabel: "idle",
    currentSessionId: "session-a",
    displayMode: "full",
    eventsLength: 3,
    handleCompactDisplayModeToggle: vi.fn(),
    handleCopyEventJson: vi.fn(),
    handleMoveSession: vi.fn(),
    handleOpenCloudShareSettings: vi.fn(),
    handleOpenExportSessionJson: vi.fn(),
    handleOpenLinkWorkItem: vi.fn(),
    handleOpenSearch: vi.fn(),
    handlePaginationToggle: vi.fn(),
    handleReloadFromMenu: vi.fn(),
    handleTokenUsageVisibleToggle: vi.fn(),
    handleTurnMetadataVisibleToggle: vi.fn(),
    headerActionsDropdownRef: createRef<HTMLDivElement>(),
    headerActionsPosition: {
      left: 700,
      right: 20,
      top: 50,
      width: 200,
      maxHeight: 600,
    },
    headerActionsTriggerRef: createRef<HTMLButtonElement>(),
    isHeaderActionsOpen: true,
    isHeaderActionsPositioned: true,
    moveTarget: "workstation",
    paginationEnabled: false,
    showCloudShareSettings: false,
    tokenUsageVisible: false,
    turnMetadataVisible: true,
    toggleHeaderActionsMenu: vi.fn(),
    triggerTestId: "session-menu-trigger",
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionHeaderActionsMenu", () => {
  it("uses the cursor-in-window glyph for Move to and the Mac window glyph for New Window", () => {
    render();
    click("session-move-submenu");
    for (const [testId, icon] of [
      ["session-move-submenu", CursorInWindowIcon],
      ["open-session-in-new-window", AppWindowMacIcon],
    ] as const) {
      const paths = element(testId).firstElementChild!.querySelectorAll("path");
      expect(Array.from(paths, (path) => path.getAttribute("d"))).toEqual(
        icon.map(([, attributes]) => attributes.d)
      );
    }
  });

  it("uses the copy glyph for the group and braces for event JSON", () => {
    render();
    click("session-copy-submenu");
    for (const [testId, icon] of [
      ["session-copy-submenu", Copy01Icon],
      ["session-copy-event-json-button", ThirdBracketIcon],
    ] as const) {
      const paths = element(testId).firstElementChild!.querySelectorAll("path");
      expect(Array.from(paths, (path) => path.getAttribute("d"))).toEqual(
        icon.map(([, attributes]) => attributes.d)
      );
    }
  });

  it("renders right-pointing chevron paths for the left-opening submenus", () => {
    render();
    for (const testId of [
      "session-copy-submenu",
      "session-move-submenu",
      "session-project-links-submenu",
      "session-ui-settings-submenu",
    ]) {
      const suffix = element(testId).lastElementChild;
      const chevron = suffix?.querySelector("svg");
      // Check the actual SVG, not the icon's name: both endpoints are at
      // x=9 and the middle tip is at x=15, so this glyph points right.
      expect(chevron?.querySelector("path")?.getAttribute("d")).toBe(
        "M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18"
      );
      expect(chevron?.getAttribute("transform")).toBeNull();
      expect(chevron?.getAttribute("class")).not.toMatch(/rotate|scale/);
    }
  });

  it("groups copy, export and move actions and removes muting from the top level", () => {
    render();
    expect(element("session-copy-submenu").textContent).toBe(
      "chat.copyAndExport"
    );
    element("session-move-submenu");
    expect(
      document.querySelector('[data-testid="view-raw-session-transcript"]')
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "chat.rawTranscript.menuItem"
    );
    expect(
      document.querySelector('[data-testid="session-copy-event-json-button"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="session-copy-url-button"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="session-export-button"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="move-session-to-workstation"]')
    ).toBeNull();
    expect(document.body.textContent).not.toContain("muteNotifications");
    expect(
      document.querySelector('[data-testid="session-notification-mute-row"]')
    ).toBeNull();

    click("session-copy-submenu");
    const panel = element("session-copy-submenu-panel");
    expect(panel.contains(element("session-copy-event-json-button"))).toBe(
      true
    );
    expect(panel.contains(element("session-copy-url-button"))).toBe(true);
    expect(panel.contains(element("session-export-button"))).toBe(true);
    expect(element("session-export-button").textContent).toBe(
      "chat.importExport.exportJson"
    );
    expect(
      document.querySelectorAll('[data-testid="session-export-button"]')
    ).toHaveLength(1);
    click("session-export-button");
    expect(props.handleOpenExportSessionJson).toHaveBeenCalledOnce();
    click("session-copy-event-json-button");
    expect(props.handleCopyEventJson).toHaveBeenCalledOnce();
    click("session-copy-url-button");
    expect(mocks.copyReference).toHaveBeenCalledOnce();
    expect(mocks.copyReference).toHaveBeenCalledWith(mocks.session);
    expect(props.toggleHeaderActionsMenu).toHaveBeenCalledOnce();
  });

  it("keeps both destination actions and the reverse move in My Station", async () => {
    render();
    click("session-move-submenu");
    click("move-session-to-workstation");
    expect(props.handleMoveSession).toHaveBeenCalledOnce();
    await act(async () => element("open-session-in-new-window").click());
    expect(mocks.openWindow).toHaveBeenCalledOnce();
    expect(mocks.openWindow).toHaveBeenCalledWith({
      sessionId: "session-a",
      title: "Session A",
    });
    render({ moveTarget: "chat-panel" });
    element("move-session-to-chat-panel");
    render({ showMoveSession: false, showOpenInNewWindow: false });
    expect(
      document.querySelector('[data-testid="session-move-submenu"]')
    ).toBeNull();
  });

  it("preserves export eligibility and disabled states inside the submenu", () => {
    render({ activeSessionExists: false });
    click("session-copy-submenu");
    expect(element("session-export-button").getAttribute("aria-disabled")).toBe(
      "true"
    );
    click("session-export-button");
    expect(props.handleOpenExportSessionJson).not.toHaveBeenCalled();
    render({ activeSessionExists: true, showTranscriptActions: false });
    element("session-copy-url-button");
    expect(
      document.querySelector('[data-testid="session-export-button"]')
    ).toBeNull();
  });

  it("nests project actions in a flyout separately from sharing and UI settings", () => {
    render({ showCloudShareSettings: true });
    expect(submenuIds()).toEqual([
      "session-move-submenu",
      "session-copy-submenu",
      "session-project-links-submenu",
      "session-ui-settings-submenu",
    ]);
    expect(
      document.querySelector('[data-testid="session-track-as-project-button"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="session-link-work-item-button"]')
    ).toBeNull();
    expect(element("session-project-links-submenu").textContent).toBe(
      "chat.projectLinks"
    );
    click("session-project-links-submenu");
    const group = element("session-project-links-submenu-panel");
    expect(group.getAttribute("role")).toBe("menu");
    expect(
      element("session-project-links-submenu").getAttribute("aria-expanded")
    ).toBe("true");
    expect(
      [...group.querySelectorAll('[role="menuitem"]')].map((row) =>
        row.getAttribute("data-testid")
      )
    ).toEqual([
      "session-track-as-project-button",
      "session-link-work-item-button",
    ]);
    expect(group.contains(element("cloud-session-share-settings-button"))).toBe(
      false
    );
    expect(group.querySelector('[role="switch"]')).toBeNull();
    click("session-link-work-item-button");
    expect(props.handleOpenLinkWorkItem).toHaveBeenCalledOnce();
    click("cloud-session-share-settings-button");
    expect(props.handleOpenCloudShareSettings).toHaveBeenCalledOnce();
  });

  it("preserves project action eligibility and keyboard access in the group", () => {
    render();
    click("session-project-links-submenu");
    expect(
      element("session-track-as-project-button").getAttribute("aria-disabled")
    ).toBe("true");
    render({ currentSessionId: "osagent-a" });
    const track = element("session-track-as-project-button");
    const link = element("session-link-work-item-button");
    expect(track.getAttribute("aria-disabled")).not.toBe("true");
    act(() => track.focus());
    key("ArrowDown");
    expect(document.activeElement).toBe(link);
    key("Enter");
    expect(props.handleOpenLinkWorkItem).toHaveBeenCalledOnce();

    render({ currentSessionId: null });
    expect(
      element("session-project-links-submenu").getAttribute("aria-disabled")
    ).toBe("true");
    for (const testId of [
      "session-track-as-project-button",
      "session-link-work-item-button",
    ]) {
      expect(element(testId).getAttribute("aria-disabled")).toBe("true");
      expect(element(testId).tabIndex).toBe(-1);
      click(testId);
    }
    expect(props.handleOpenLinkWorkItem).toHaveBeenCalledOnce();
    expect(props.toggleHeaderActionsMenu).not.toHaveBeenCalled();
  });

  it("nests the four display switches under UI settings without closing on toggle", () => {
    render();
    expect(document.querySelector('[role="switch"]')).toBeNull();
    expect(element("session-ui-settings-submenu").textContent).toBe(
      "common:actions.uiSettings"
    );
    click("session-ui-settings-submenu");
    const panel = element("session-ui-settings-submenu-panel");
    const switches =
      panel.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(
      [...switches].map((control) => control.getAttribute("aria-label"))
    ).toEqual([
      "chat.showTokenUsage",
      "chat.showTurnMetadata",
      "common:pagination.title",
      "chat.compactDisplayMode",
    ]);
    expect(switches[0].closest('[role="menu"]')).toBe(panel);
    key("ArrowDown");
    expect(document.activeElement).toBe(switches[0]);
    key("ArrowDown");
    expect(document.activeElement).toBe(switches[1]);
    act(() => switches.forEach((control) => control.click()));
    expect(props.handleTokenUsageVisibleToggle).toHaveBeenCalledWith(
      true,
      expect.anything()
    );
    expect(props.handleTurnMetadataVisibleToggle).toHaveBeenCalledWith(
      false,
      expect.anything()
    );
    expect(props.handlePaginationToggle).toHaveBeenCalledWith(
      true,
      expect.anything()
    );
    expect(props.handleCompactDisplayModeToggle).toHaveBeenCalledWith(
      true,
      expect.anything()
    );
    expect(props.toggleHeaderActionsMenu).not.toHaveBeenCalled();
    expect(
      element("session-ui-settings-submenu").getAttribute("aria-expanded")
    ).toBe("true");
    key("Escape");
    expect(document.querySelector('[role="switch"]')).toBeNull();
    expect(document.activeElement).toBe(element("session-ui-settings-submenu"));
    expect(props.toggleHeaderActionsMenu).not.toHaveBeenCalled();

    render({ showTranscriptActions: false });
    expect(document.body.textContent).not.toContain(
      "common:actions.uiSettings"
    );
    expect(document.querySelector('[role="switch"]')).toBeNull();
  });

  it("preserves copy eligibility and disabled states", () => {
    mocks.eligible = false;
    render({ eventsLength: 0, currentSessionId: null });
    click("session-move-submenu");
    expect(
      document.querySelector('[data-testid="session-move-submenu-panel"]')
    ).toBeNull();
    click("session-copy-submenu");
    expect(
      element("session-copy-event-json-button").getAttribute("aria-disabled")
    ).toBe("true");
    click("session-copy-event-json-button");
    expect(props.handleCopyEventJson).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="session-copy-url-button"]')
    ).toBeNull();
    render({ showTranscriptActions: false });
    expect(
      document.querySelector('[data-testid="session-copy-submenu"]')
    ).toBeNull();
  });

  it("preserves the hover grace through the bridge and switches one submenu at a time", () => {
    vi.useFakeTimers();
    render({ showCloudShareSettings: true });
    const copy = element("session-copy-submenu");
    const move = element("session-move-submenu");
    const parent = props.headerActionsDropdownRef.current!;
    movePointer(null, copy);
    const flyout = element("session-copy-submenu-panel").parentElement!;
    click("session-copy-submenu");
    movePointer(copy, parent);
    element("session-copy-submenu-panel");
    movePointer(parent, flyout);
    element("session-copy-submenu-panel");
    movePointer(flyout, move);
    act(() => vi.advanceTimersByTime(349));
    element("session-copy-submenu-panel");
    expect(
      document.querySelectorAll("[data-action-menu-submenu]")
    ).toHaveLength(1);
    // Reaching the flyout bridge cancels the pending sibling switch.
    movePointer(move, flyout);
    act(() => vi.advanceTimersByTime(350));
    element("session-copy-submenu-panel");
    expect(
      document.querySelector('[data-testid="session-move-submenu-panel"]')
    ).toBeNull();

    movePointer(flyout, move);
    act(() => vi.advanceTimersByTime(349));
    element("session-copy-submenu-panel");
    act(() => vi.advanceTimersByTime(1));
    element("session-move-submenu-panel");
    expect(
      document.querySelector('[data-testid="session-copy-submenu-panel"]')
    ).toBeNull();
    movePointer(move, element("cloud-session-share-settings-button"));
    act(() => vi.advanceTimersByTime(349));
    element("session-move-submenu-panel");
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector("[data-action-menu-submenu]")).toBeNull();
  });

  it("navigates into the left submenu and back without closing the parent", () => {
    render();
    element("session-copy-submenu").focus();
    key("ArrowLeft");
    element("session-copy-submenu-panel");
    key("ArrowDown");
    expect(document.activeElement).toBe(
      element("session-copy-event-json-button")
    );
    key("Enter");
    expect(props.handleCopyEventJson).toHaveBeenCalledOnce();
    key("End");
    expect(document.activeElement).toBe(element("session-export-button"));
    key("Enter");
    expect(props.handleOpenExportSessionJson).toHaveBeenCalledOnce();
    key("ArrowUp");
    expect(document.activeElement).toBe(element("session-copy-url-button"));
    key("ArrowRight");
    expect(document.activeElement).toBe(element("session-copy-submenu"));
    expect(props.toggleHeaderActionsMenu).not.toHaveBeenCalled();
    key("Enter");
    element("session-copy-submenu-panel");
    key("Escape");
    expect(document.querySelector("[data-action-menu-submenu]")).toBeNull();
    key("Escape");
    expect(props.toggleHeaderActionsMenu).toHaveBeenCalledOnce();
  });

  it.each([
    "session-copy-submenu",
    "session-move-submenu",
    "session-project-links-submenu",
    "session-ui-settings-submenu",
  ])(
    "uses the shared gap for %s and clamps its bottom to the viewport",
    (testId) => {
      const panelWidth = 208;
      const panelHeight = 100;
      const parentLeft = 700;
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect"
      ).mockImplementation(function (this: HTMLElement) {
        const isFlyout = this.className === "fixed";
        const isPanel = this.hasAttribute("data-action-menu-submenu");
        const width = isFlyout
          ? panelWidth + DROPDOWN_PANEL.submenuGap
          : isPanel
            ? panelWidth
            : 200;
        const height = isFlyout || isPanel ? panelHeight : 32;
        return {
          left: parentLeft,
          right: parentLeft + width,
          top: 700,
          bottom: 700 + height,
          width,
          height,
          x: parentLeft,
          y: 700,
          toJSON: () => ({}),
        };
      });
      render();
      click(testId);
      const flyout = element(`${testId}-panel`).parentElement!;
      expect(flyout.style.paddingRight).toBe(`${DROPDOWN_PANEL.submenuGap}px`);
      expect(parentLeft - (parseFloat(flyout.style.left) + panelWidth)).toBe(
        DROPDOWN_PANEL.submenuGap
      );
      expect(parseFloat(flyout.style.top)).toBeLessThanOrEqual(
        window.innerHeight - panelHeight - DROPDOWN_PANEL.viewportPadding
      );
    }
  );

  it("disposes open submenus and keyboard listeners when the parent closes", () => {
    render();
    click("session-copy-submenu");
    render({ isHeaderActionsOpen: false });
    key("Escape");
    expect(props.toggleHeaderActionsMenu).not.toHaveBeenCalled();
    render({ isHeaderActionsOpen: true });
    expect(document.querySelector("[data-action-menu-submenu]")).toBeNull();
    key("Escape");
    expect(props.toggleHeaderActionsMenu).toHaveBeenCalledOnce();
  });
});

function appPlan(app = "Claude"): ExternalHistoryAppOpenPlan {
  return {
    source: app === "Claude" ? "claude_code" : "codex_app",
    appDisplayName: app,
    deepLink: `${app.toLowerCase()}://test-session`,
    nativeSessionId: "native-session",
    sourceAvailable: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("SessionHeaderActionsMenu native app action", () => {
  it.each([
    ["claudecodeapp-session-a", "Claude", "claude", "claude"],
    ["codexapp-session-a", "Codex", "codex", "openai"],
  ])(
    "shows %s as a direct row between separators with its brand and up-right arrow",
    async (sessionId, app, iconId, brand) => {
      mocks.appOpenPlan.mockResolvedValue(appPlan(app));
      await act(async () => render({ currentSessionId: sessionId }));

      expect(submenuIds()).toEqual([
        "session-move-submenu",
        "session-copy-submenu",
        "session-project-links-submenu",
        "session-ui-settings-submenu",
      ]);
      expect(
        document.querySelector('[data-testid="session-open-in-app-submenu"]')
      ).toBeNull();
      const row = element("session-open-in-app-menu-item");
      const wrapper = row.parentElement!;
      for (const separator of [
        wrapper.previousElementSibling,
        wrapper.nextElementSibling,
      ]) {
        expect(separator?.className).toBe(DROPDOWN_CLASSES.menuGroupSeparator);
      }
      const topSection = element(
        "session-project-links-submenu"
      ).parentElement!;
      expect(topSection.nextElementSibling).toBe(
        wrapper.previousElementSibling
      );
      expect(wrapper.nextElementSibling?.nextElementSibling).toBe(
        element("session-ui-settings-submenu").parentElement
      );
      expect(row.textContent).toBe(`Open in ${app}`);
      expect(row.getAttribute("role")).toBe("menuitem");
      expect(row.getAttribute("aria-haspopup")).toBeNull();
      expect(row.closest('[role="menu"]')).toBe(
        props.headerActionsDropdownRef.current
      );
      const icon = row.firstElementChild?.querySelector("svg");
      expect(icon?.getAttribute("data-icon")).toBe(iconId);
      expect(icon?.getAttribute("data-brand")).toBe(brand);
      const arrow = row.lastElementChild?.querySelector("svg");
      expect(arrow?.getAttribute("data-icon")).toBe("arrow-up-right");
      expect(arrow?.querySelector("path")?.getAttribute("d")).toBe(
        ArrowUpRight01Icon[0][1].d
      );
      expect(
        document.querySelector('[data-testid="session-open-in-app-button"]')
      ).toBeNull();

      await act(async () => row.click());
      expect(mocks.openInApp).toHaveBeenCalledOnce();
      expect(mocks.openInApp).toHaveBeenCalledWith(sessionId);
      expect(props.toggleHeaderActionsMenu).toHaveBeenCalledOnce();
    }
  );

  it.each([
    null,
    "session-a",
    "cursoride-a",
    "cursorcliapp-a",
    "opencodeapp-a",
  ])(
    "does no native-app work for unsupported session %s",
    async (sessionId) => {
      await act(async () => render({ currentSessionId: sessionId }));
      expect(mocks.appOpenPlan).not.toHaveBeenCalled();
      expect(
        document.querySelector('[data-testid="session-open-in-app-menu-item"]')
      ).toBeNull();
      expect(document.querySelectorAll('[role="separator"]')).toHaveLength(0);
    }
  );

  it("loads only when the menu opens, and keeps the row absent while the plan is pending", async () => {
    const pending = deferred<ExternalHistoryAppOpenPlan>();
    mocks.appOpenPlan.mockReturnValueOnce(pending.promise);
    await act(async () =>
      render({
        currentSessionId: "claudecodeapp-a",
        isHeaderActionsOpen: false,
      })
    );
    expect(mocks.appOpenPlan).not.toHaveBeenCalled();

    await act(async () => render({ isHeaderActionsOpen: true }));
    expect(mocks.appOpenPlan).toHaveBeenCalledOnce();
    expect(mocks.appOpenPlan).toHaveBeenCalledWith("claudecodeapp-a");
    expect(
      document.querySelector('[data-testid="session-open-in-app-menu-item"]')
    ).toBeNull();
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(0);
    await act(async () => pending.resolve(appPlan()));
    element("session-open-in-app-menu-item");
    render({ tokenUsageVisible: true });
    expect(mocks.appOpenPlan).toHaveBeenCalledOnce();
  });

  it("disables missing source data and keeps its explanatory tooltip", async () => {
    vi.useFakeTimers();
    mocks.appOpenPlan.mockResolvedValue({
      ...appPlan(),
      sourceAvailable: false,
    });
    await act(async () => render({ currentSessionId: "claudecodeapp-a" }));
    const row = element("session-open-in-app-menu-item");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.tabIndex).toBe(-1);
    row.click();
    expect(mocks.openInApp).not.toHaveBeenCalled();
    expect(props.toggleHeaderActionsMenu).not.toHaveBeenCalled();
    act(() => {
      row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(200);
    });
    expect(document.body.textContent).toContain(
      "collaboration.openInApp.sourceMissing"
    );
    render({ isHeaderActionsOpen: false });
    // The shared tooltip can have one positioning frame already queued.
    // Its detached-ref guard makes that frame a no-op, with no follow-up work.
    act(() => vi.advanceTimersByTime(16));
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("uses the submenu gap for the open-in-app tooltip", async () => {
    vi.useFakeTimers();
    mocks.appOpenPlan.mockResolvedValue(appPlan());
    await act(async () => render({ currentSessionId: "claudecodeapp-a" }));
    const row = element("session-open-in-app-menu-item");
    const menu = row.closest<HTMLElement>('[role="menu"]')!;
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(
      new DOMRect(600, 100, 180, 400)
    );
    vi.spyOn(row.parentElement!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(605, 220, 170, 32)
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
    act(() => {
      row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(200);
    });
    act(() => vi.advanceTimersByTime(32));
    const tooltip = document.querySelector<HTMLElement>(".native-tooltip")!;
    expect(tooltip.style.left).toBe(
      `${600 - 320 - DROPDOWN_PANEL.submenuGap}px`
    );
    expect(tooltip.style.top).toBe("196px");
  });

  it("cancels a pending tooltip delay when the menu closes", async () => {
    vi.useFakeTimers();
    mocks.appOpenPlan.mockResolvedValue(appPlan());
    await act(async () => render({ currentSessionId: "claudecodeapp-a" }));
    act(() => {
      element("session-open-in-app-menu-item").dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true })
      );
    });
    expect(vi.getTimerCount()).toBe(1);
    render({ isHeaderActionsOpen: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the direct app row mounted while switching the remaining flyouts", async () => {
    vi.useFakeTimers();
    mocks.appOpenPlan.mockResolvedValue(appPlan());
    await act(async () => render({ currentSessionId: "claudecodeapp-a" }));
    const row = element("session-open-in-app-menu-item");

    for (const testId of [
      "session-ui-settings-submenu",
      "session-project-links-submenu",
      "session-copy-submenu",
      "session-move-submenu",
    ]) {
      click(testId);
      expect(
        document.querySelectorAll("[data-action-menu-submenu]")
      ).toHaveLength(1);
      expect(element(`${testId}-panel`)).toBeDefined();
      expect(element("session-open-in-app-menu-item")).toBe(row);
    }
    movePointer(element("session-move-submenu"), row);
    act(() => vi.advanceTimersByTime(349));
    element("session-move-submenu-panel");
    expect(element("session-open-in-app-menu-item")).toBe(row);
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector("[data-action-menu-submenu]")).toBeNull();
    expect(element("session-open-in-app-menu-item")).toBe(row);
    expect(mocks.appOpenPlan).toHaveBeenCalledOnce();
    expect(mocks.openInApp).not.toHaveBeenCalled();
    expect(props.toggleHeaderActionsMenu).not.toHaveBeenCalled();
  });

  it("does not render a backend-rejected or failed plan", async () => {
    await act(async () =>
      render({ currentSessionId: "claudecodeapp-subagent" })
    );
    expect(
      document.querySelector('[data-testid="session-open-in-app-menu-item"]')
    ).toBeNull();
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(0);
    mocks.appOpenPlan.mockRejectedValueOnce(new Error("plan unavailable"));
    await act(async () => render({ currentSessionId: "codexapp-a" }));
    expect(
      document.querySelector('[data-testid="session-open-in-app-menu-item"]')
    ).toBeNull();
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(0);
    expect(mocks.openInApp).not.toHaveBeenCalled();
  });

  it("discards late plans after switching sessions and after closing", async () => {
    const first = deferred<ExternalHistoryAppOpenPlan>();
    const second = deferred<ExternalHistoryAppOpenPlan>();
    mocks.appOpenPlan
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await act(async () => render({ currentSessionId: "claudecodeapp-a" }));
    await act(async () => render({ currentSessionId: "codexapp-b" }));
    await act(async () => first.resolve(appPlan()));
    expect(
      document.querySelector('[data-testid="session-open-in-app-menu-item"]')
    ).toBeNull();
    render({ isHeaderActionsOpen: false });
    await act(async () => second.resolve(appPlan("Codex")));
    expect(
      document.querySelector('[data-testid="session-open-in-app-menu-item"]')
    ).toBeNull();
    mocks.appOpenPlan.mockResolvedValue(appPlan("Codex"));
    await act(async () => render({ isHeaderActionsOpen: true }));
    expect(element("session-open-in-app-menu-item").textContent).toBe(
      "Open in Codex"
    );
    expect(mocks.appOpenPlan).toHaveBeenCalledTimes(3);
  });

  it.each(["Enter", " "])(
    "supports %s activation without launching twice",
    async (activationKey) => {
      const launch = deferred<void>();
      mocks.appOpenPlan.mockResolvedValue(appPlan());
      mocks.openInApp.mockReturnValueOnce(launch.promise);
      await act(async () => render({ currentSessionId: "claudecodeapp-a" }));
      const row = element("session-open-in-app-menu-item");
      act(() => row.focus());
      expect(document.activeElement).toBe(row);
      key(activationKey);
      key(activationKey);
      expect(mocks.openInApp).toHaveBeenCalledOnce();
      expect(props.toggleHeaderActionsMenu).toHaveBeenCalledOnce();
      render({ isHeaderActionsOpen: false });
      await act(async () => launch.resolve());
      // Finishing the OS request must not reopen a menu already dismissed.
      expect(props.toggleHeaderActionsMenu).toHaveBeenCalledOnce();
    }
  );

  it("reports native launch failure after dismissing the menu", async () => {
    mocks.appOpenPlan.mockResolvedValue(appPlan());
    mocks.openInApp.mockRejectedValueOnce(new Error("app not installed"));
    await act(async () => render({ currentSessionId: "claudecodeapp-a" }));
    await act(async () => element("session-open-in-app-menu-item").click());
    expect(props.toggleHeaderActionsMenu).toHaveBeenCalledOnce();
    expect(mocks.messageError).toHaveBeenCalledWith(
      "collaboration.openInApp.openFailed"
    );
  });
});

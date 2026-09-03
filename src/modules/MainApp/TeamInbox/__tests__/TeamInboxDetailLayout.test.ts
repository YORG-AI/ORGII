// @vitest-environment jsdom
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
  ClipboardListIcon,
  HugeiconsIcon,
  InternetIcon,
  LinkSquare02Icon,
} from "@src/icons";

import TeamInboxDetailLayout from "../components/TeamInboxDetailLayout";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("TeamInboxDetailLayout header actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders read, browser, and open actions in order", () => {
    const onMarkUnread = vi.fn();
    const onOpenInBrowser = vi.fn();
    const onOpen = vi.fn();

    act(() => {
      root.render(
        createElement(TeamInboxDetailLayout, {
          title: "Assigned work item",
          subtitle: "Assigned to you",
          icon: ClipboardListIcon,
          unread: false,
          markReadLabel: "Mark read",
          markUnreadLabel: "Mark unread",
          openLabel: "Open in New Tab",
          openIcon: createElement(HugeiconsIcon, {
            icon: LinkSquare02Icon,
            "aria-hidden": true,
          }),
          headerAuxiliaryAction: {
            label: "Open in browser",
            icon: createElement(HugeiconsIcon, {
              icon: InternetIcon,
              "aria-hidden": true,
            }),
            onClick: onOpenInBrowser,
          },
          onMarkUnread,
          onOpen,
        })
      );
    });

    const markUnread = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Mark unread"]'
    );
    const open = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open in New Tab"]'
    );
    const openInBrowser = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open in browser"]'
    );

    expect(
      container.querySelector('[data-detail-pane-layout="true"]')
    ).not.toBeNull();
    expect(markUnread).not.toBeNull();
    expect(openInBrowser).not.toBeNull();
    expect(open).not.toBeNull();

    for (const button of [markUnread, openInBrowser, open]) {
      expect(button?.textContent).toBe("");
      expect(button?.className).toContain("bg-transparent");
      expect(button?.className).toContain("text-text-2");
      expect(button?.style.width).toBe("28px");
      expect(button?.style.padding).toBe("0px");
      expect(button?.style.borderRadius).toBe("8px");
    }

    expect(markUnread?.title).toBe("");
    expect(open?.title).toBe("");
    expect(markUnread?.parentElement?.className).toContain("inline-flex");
    expect(open?.parentElement?.className).toContain("inline-flex");

    const actions = container.querySelector<HTMLElement>(
      '[data-testid="team-inbox-detail-actions"]'
    );
    const header = actions?.parentElement?.parentElement;
    expect(actions?.className).toContain("gap-px");
    expect(
      Array.from(actions?.querySelectorAll("button") ?? []).map((button) =>
        button.getAttribute("aria-label")
      )
    ).toEqual(["Mark unread", "Open in browser", "Open in New Tab"]);
    expect(header?.className).toContain("h-9");
    expect(header?.className).not.toContain("h-10");
    expect(header?.className).toContain("items-center");
    expect(header?.className).toContain("pl-4!");
    expect(header?.className).toContain("pr-[7px]!");

    markUnread?.click();
    openInBrowser?.click();
    open?.click();
    expect(onMarkUnread).toHaveBeenCalledOnce();
    expect(onOpenInBrowser).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("lets shared detail tabs own the header while the full title lives below", () => {
    act(() => {
      root.render(
        createElement(TeamInboxDetailLayout, {
          title: "Support Agent Browser",
          subtitle: "Assigned to you",
          icon: ClipboardListIcon,
          headerContent: createElement(
            "span",
            { "data-testid": "canonical-inbox-title" },
            "Issue #47"
          ),
          headerTabs: createElement(
            "nav",
            { "data-testid": "shared-inbox-tabs" },
            "Conversation Linked"
          ),
          unread: true,
          markReadLabel: "Mark read",
          openLabel: "Open in New Tab",
          openIcon: createElement(HugeiconsIcon, {
            icon: LinkSquare02Icon,
            "aria-hidden": true,
          }),
        })
      );
    });

    expect(
      container.querySelector("[data-testid='canonical-inbox-title']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='shared-inbox-tabs']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='shared-inbox-tabs']")?.textContent
    ).toBe("Conversation Linked");
  });

  it("shows the shared shortcut-style tooltip for each action", () => {
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(
          createElement(TeamInboxDetailLayout, {
            title: "Assigned work item",
            subtitle: "Assigned to you",
            icon: ClipboardListIcon,
            unread: false,
            markReadLabel: "Mark read",
            markUnreadLabel: "Mark unread",
            openLabel: "Open in New Tab",
            openIcon: createElement(HugeiconsIcon, {
              icon: LinkSquare02Icon,
              "aria-hidden": true,
            }),
            onMarkUnread: vi.fn(),
            onOpen: vi.fn(),
          })
        );
      });

      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Mark unread"]'
      )?.parentElement;
      act(() => {
        trigger?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        vi.advanceTimersByTime(200);
      });

      expect(document.body.textContent).toContain("Mark unread");
    } finally {
      vi.useRealTimers();
    }
  });
});

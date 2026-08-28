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
  SquareArrowUpRightIcon,
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
          openLabel: "Open work item",
          openIcon: createElement(HugeiconsIcon, {
            icon: SquareArrowUpRightIcon,
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
          openPlacement: "header",
          onMarkUnread,
          onOpen,
        })
      );
    });

    const markUnread = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Mark unread"]'
    );
    const open = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open work item"]'
    );
    const openInBrowser = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open in browser"]'
    );

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
    ).toEqual(["Mark unread", "Open in browser", "Open work item"]);
    expect(header?.className).toContain("h-10");
    expect(header?.className).toContain("items-center");
    expect(header?.className).toContain("!pl-4");
    expect(header?.className).toContain("!pr-[7px]");

    markUnread?.click();
    openInBrowser?.click();
    open?.click();
    expect(onMarkUnread).toHaveBeenCalledOnce();
    expect(onOpenInBrowser).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
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
            openLabel: "Open work item",
            openIcon: createElement(HugeiconsIcon, {
              icon: SquareArrowUpRightIcon,
              "aria-hidden": true,
            }),
            openPlacement: "header",
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

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

import { Settings01Icon } from "@src/icons";

import SettingsSearchDropdown, {
  type SettingsSearchDropdownGroup,
  type SettingsSearchDropdownItem,
} from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { query?: string }) =>
      key === "noSettingsFound"
        ? `No settings found for "${options?.query ?? ""}"`
        : key === "searchPlaceholder"
          ? "Search settings..."
          : key,
  }),
}));

const ITEMS: readonly SettingsSearchDropdownItem[] = [
  {
    id: "appearance",
    label: "外观",
    path: "/settings/app/appearance",
    icon: Settings01Icon,
    groupId: "app",
  },
  {
    id: "connections",
    label: "Connections",
    path: "/settings/integrations/connections",
    icon: Settings01Icon,
    groupId: "connections",
  },
  {
    id: "git",
    label: "Git",
    path: "/settings/integrations/git",
    icon: Settings01Icon,
    groupId: "connections",
    searchTerms: ["version control source control"],
  },
  {
    id: "externalSkillsets",
    label: "Skills, MCPs, Plugins",
    path: "/settings/integrations/skills-mcps-plugins",
    icon: Settings01Icon,
    groupId: "tools",
  },
];

const GROUPS: readonly SettingsSearchDropdownGroup[] = [
  { id: "app", label: null, items: ITEMS.slice(0, 1) },
  { id: "connections", label: "Connections", items: ITEMS.slice(1, 3) },
  { id: "tools", label: "Agent tools", items: ITEMS.slice(3) },
];

const CONTROL_GROUPS: readonly SettingsSearchDropdownGroup[] = [
  {
    id: "appearance",
    label: "Appearance",
    items: [
      {
        id: "settings-row-skin",
        label: "皮肤",
        path: "/settings/app/appearance",
        icon: Settings01Icon,
        groupId: "appearance",
        searchTerms: ["Choose the app palette"],
      },
    ],
  },
];

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SettingsSearchDropdown", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelect = vi.fn();
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store: createStore() },
          React.createElement(SettingsSearchDropdown, {
            groups: GROUPS,
            activeItemId: "appearance",
            onSelect,
            renderTrigger: ({ isOpen, listboxId, onClick }) =>
              React.createElement(
                "button",
                {
                  type: "button",
                  "aria-expanded": isOpen,
                  "aria-controls": listboxId,
                  onClick,
                },
                "Open settings search"
              ),
          })
        )
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document
      .querySelectorAll('[data-testid="settings-navigation-search-panel"]')
      .forEach((panel) => panel.remove());
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function openDropdown(): Promise<HTMLInputElement> {
    const trigger = container.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      trigger?.click();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    });
    const input = document.body.querySelector<HTMLInputElement>(
      '[data-testid="settings-navigation-search-input"] input'
    );
    expect(input).not.toBeNull();
    return input!;
  }

  it("filters the supplied navigation model without maintaining another index", async () => {
    const input = await openDropdown();

    act(() => setInputValue(input, "git"));

    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-git"]'
      )
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-appearance"]'
      )
    ).toBeNull();
  });

  it("treats group names as context rather than search matches", async () => {
    const input = await openDropdown();

    act(() => setInputValue(input, "connections"));

    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-connections"]'
      )
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-git"]'
      )
    ).toBeNull();
  });

  it("matches metadata supplied by the page item index", async () => {
    const input = await openDropdown();

    act(() => setInputValue(input, "version control"));

    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-git"]'
      )
    ).not.toBeNull();
  });

  it("finds a sidebar page item by text inside its localized label", async () => {
    const input = await openDropdown();

    act(() => setInputValue(input, "mcp"));

    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-externalSkillsets"]'
      )
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-tools"]'
      )
    ).toBeNull();
  });

  it("supports arrow navigation and Enter selection from the search field", async () => {
    const input = await openDropdown();
    act(() => {
      setInputValue(input, "git");
      input.focus();
    });

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    const highlightedResult = document.body.querySelector<HTMLElement>(
      '[data-testid="settings-navigation-search-result-git"]'
    );
    expect(highlightedResult?.classList.contains("bg-fill-2")).toBe(true);
    expect(highlightedResult?.dataset.dropdownItemIndex).toBe("0");
    expect(input.getAttribute("aria-activedescendant")).toBe(
      highlightedResult?.id
    );

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: "git" });
    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-panel"]'
      )
    ).toBeNull();
  });

  it("closes on Escape", async () => {
    const input = await openDropdown();

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });

    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-panel"]'
      )
    ).toBeNull();
  });

  it("waits for input before showing the left-aligned sidebar result panel", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store: createStore() },
          React.createElement(SettingsSearchDropdown, {
            variant: "search-input",
            groups: [...GROUPS, ...CONTROL_GROUPS],
            onSelect,
            align: "left",
          })
        )
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-navigation-search-input"]'
    );
    expect(input).not.toBeNull();
    expect(
      input?.closest(".input-wrapper")?.classList.contains("input-size-default")
    ).toBe(true);
    expect(input?.closest(".input-inner")?.classList.contains("bg-bg-2")).toBe(
      true
    );
    expect(
      input
        ?.closest(".input-wrapper")
        ?.classList.contains("input-sidebar-search")
    ).toBe(true);

    await act(async () => {
      input?.focus();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    });

    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-panel"]'
      )
    ).toBeNull();

    await act(async () => {
      if (input) setInputValue(input, "皮肤");
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    });

    const panel = document.body.querySelector<HTMLElement>(
      '[data-testid="settings-navigation-search-panel"]'
    );
    expect(panel).not.toBeNull();
    expect(panel?.style.left).not.toBe("");
    expect(panel?.style.right).toBe("");
    expect(
      panel?.querySelector('[data-testid="settings-navigation-search-input"]')
    ).toBeNull();
    expect(container.contains(input)).toBe(true);
    expect(
      panel?.querySelector(
        '[data-testid="settings-navigation-search-result-settings-row-skin"]'
      )
    ).not.toBeNull();

    act(() => {
      if (input) setInputValue(input, "MCP");
    });
    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-externalSkillsets"]'
      )
    ).not.toBeNull();

    act(() => {
      if (input) setInputValue(input, "");
    });
    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-panel"]'
      )
    ).toBeNull();
  });
});

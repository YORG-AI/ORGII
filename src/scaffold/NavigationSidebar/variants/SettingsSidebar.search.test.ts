// @vitest-environment jsdom
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

import type { SettingsNavigationGroup } from "@src/config/settingsNavigation";
import { Settings01Icon } from "@src/icons";
import SectionRow from "@src/modules/shared/layouts/SectionLayout/Row";

import { SettingsRootBody } from "./SettingsSidebar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { query?: string }) =>
      key === "noSettingsFound"
        ? `No settings found for "${options?.query ?? ""}"`
        : key === "searchPlaceholder"
          ? "Search settings..."
          : key === "settings:general.lightSkin"
            ? "浅色皮肤"
            : key === "settings:general.darkSkin"
              ? "深色皮肤"
              : key === "settings:general.lightAccent"
                ? "浅色强调色"
                : key === "settings:general.darkAccent"
                  ? "深色强调色"
                  : key === "settings:general.accent"
                    ? "强调色"
                    : key,
  }),
}));

const NAVIGATION_GROUPS: readonly SettingsNavigationGroup[] = [
  {
    id: "app",
    label: null,
    items: [
      {
        id: "general",
        label: "通用",
        path: "/orgii/app/settings/app/general",
        icon: Settings01Icon,
        groupId: "app",
        dataTestId: "settings-core-item-general",
      },
      {
        id: "appearance",
        label: "外观",
        path: "/orgii/app/settings/app/appearance",
        icon: Settings01Icon,
        groupId: "app",
        dataTestId: "settings-core-item-appearance",
      },
    ],
  },
  {
    id: "tools",
    label: "Agent tools",
    items: [
      {
        id: "externalSkillsets",
        label: "Skills、MCPs、Plugins",
        path: "/orgii/app/settings/integrations/skills-mcps-plugins",
        icon: Settings01Icon,
        groupId: "tools",
        dataTestId: "settings-core-item-externalSkillsets",
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

describe("SettingsRootBody search integration", () => {
  let container: HTMLDivElement;
  let root: Root;
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
          React.Fragment,
          null,
          React.createElement(
            "div",
            { "data-settings-surface": true },
            React.createElement(
              SectionRow,
              { label: "语言" },
              React.createElement("button", { type: "button" }, "Choose")
            )
          ),
          React.createElement(SettingsRootBody, {
            navigationGroups: NAVIGATION_GROUPS,
            activeItemId: "general",
            searchScopeKey: "/orgii/app/settings/app/general",
            onSelect: vi.fn(),
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
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function search(query: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-navigation-search-input"]'
    );
    expect(input).not.toBeNull();
    await act(async () => {
      if (input) setInputValue(input, query);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    });
  }

  it("finds localized controls outside the mounted page and an MCP destination", async () => {
    await search("皮肤");
    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-setting-general-lightSkin"]'
      )
    ).not.toBeNull();

    await search("强调色");
    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-setting-general-primaryColorLight"]'
      )
    ).not.toBeNull();

    await search("MCP");
    expect(
      document.body.querySelector(
        '[data-testid="settings-navigation-search-result-externalSkillsets"]'
      )
    ).not.toBeNull();
  });
});

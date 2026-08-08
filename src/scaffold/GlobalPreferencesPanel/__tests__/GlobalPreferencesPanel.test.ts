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

import { APPLICATION_PREVIEW_STYLE } from "@src/config/appearance/applicationPreviewStyle";
import {
  applicationPreviewStyleAtom,
  globalPreferencesPanelOpenAtom,
} from "@src/store/ui/globalPreferencesPanelAtom";

import GlobalPreferencesPanel from "..";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/scaffold/ModalSystem", () => ({
  default: ({
    children,
    onCancel,
    title,
    visible,
  }: {
    children: React.ReactNode;
    onCancel: () => void;
    title: string;
    visible: boolean;
  }) =>
    visible
      ? React.createElement(
          "section",
          { "data-testid": "global-preferences-modal" },
          React.createElement("h1", null, title),
          React.createElement(
            "button",
            { "data-testid": "close-panel", onClick: onCancel },
            "close"
          ),
          children
        )
      : null,
}));

vi.mock("@src/components/Select", () => ({
  default: ({
    dataTestId,
    onChange,
    options,
    value,
  }: {
    dataTestId?: string;
    onChange: (value: string) => void;
    options: Array<{ label: string; value: string }>;
    value: string;
  }) =>
    React.createElement(
      "select",
      {
        "data-testid": dataTestId,
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onChange(event.currentTarget.value),
      },
      options.map((option) =>
        React.createElement(
          "option",
          { key: option.value, value: option.value },
          option.label
        )
      )
    ),
}));

describe("GlobalPreferencesPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  const store = createStore();
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    localStorage.clear();
    store.set(applicationPreviewStyleAtom, APPLICATION_PREVIEW_STYLE.COMPACT);
    store.set(globalPreferencesPanelOpenAtom, true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(GlobalPreferencesPanel)
        )
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("updates the shared preview style and closes through the global owner", () => {
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="global-preview-style"]'
    );

    act(() => {
      if (!select) return;
      select.value = APPLICATION_PREVIEW_STYLE.MASCOT;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(store.get(applicationPreviewStyleAtom)).toBe(
      APPLICATION_PREVIEW_STYLE.MASCOT
    );

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="close-panel"]')
        ?.click();
    });

    expect(store.get(globalPreferencesPanelOpenAtom)).toBe(false);
    expect(
      container.querySelector('[data-testid="global-preferences-modal"]')
    ).toBeNull();
  });
});

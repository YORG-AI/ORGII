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

import SectionRow from "../../SectionLayout/Row";
import {
  collectRenderedSettingsControls,
  revealRenderedSettingsControl,
  revealSettingsControlWhenRendered,
} from "./settingsControlSearch";

describe("settings control search target", () => {
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

  it("reveals the result row and focuses its first control", () => {
    act(() => {
      root.render(
        React.createElement(
          "div",
          { "data-settings-surface": true },
          React.createElement(
            SectionRow,
            {
              label: "皮肤",
              settingsSearchKeys: ["general.lightSkin", "general.darkSkin"],
            },
            React.createElement("button", { type: "button" }, "Choose")
          )
        )
      );
    });

    const row = container.querySelector<HTMLElement>(
      "[data-settings-search-row]"
    );
    const scrollIntoView = vi.fn();
    if (row) row.scrollIntoView = scrollIntoView;

    expect(
      revealRenderedSettingsControl({ searchKey: "general.darkSkin" })
    ).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(document.activeElement?.textContent).toBe("Choose");
  });

  it("snapshots localized page rows without a separately maintained index", () => {
    act(() => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(
            SectionRow,
            { label: "Outside Settings" },
            React.createElement("button", { type: "button" }, "Ignore")
          ),
          React.createElement(
            "div",
            { "data-settings-surface": true },
            React.createElement(
              SectionRow,
              {
                label: "皮肤",
                description: "选择应用配色",
                required: true,
              },
              React.createElement("button", { type: "button" }, "Choose")
            ),
            React.createElement(
              SectionRow,
              { label: "Headerless", showHeader: false },
              React.createElement("button", { type: "button" }, "Ignore")
            )
          )
        )
      );
    });

    expect(collectRenderedSettingsControls()).toEqual([
      expect.objectContaining({
        label: "皮肤",
        description: "选择应用配色",
        searchKeys: [],
      }),
    ]);
  });

  it("waits for a globally selected control to render, then cleans up", async () => {
    const stopWaiting = revealSettingsControlWhenRendered({
      searchKey: "general.primaryColorLight",
      label: "浅色强调色",
    });

    await act(async () => {
      root.render(
        React.createElement(
          "div",
          { "data-settings-surface": true },
          React.createElement(
            SectionRow,
            {
              label: "浅色强调色",
              settingsSearchKeys: "general.primaryColorLight",
            },
            React.createElement("button", { type: "button" }, "Choose accent")
          )
        )
      );
      await Promise.resolve();
    });

    expect(document.activeElement?.textContent).toBe("Choose accent");
    stopWaiting();
  });
});

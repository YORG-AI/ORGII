// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getStoredTrailTerminalHeight,
  getStoredTrailTerminalWidth,
  persistTrailTerminalSize,
} from "./railStorage";
import { useTrailPanelDimensions } from "./useTrailPanelDimensions";

function DimensionProbe() {
  const dimensions = useTrailPanelDimensions();
  const terminal = { width: 570, height: 350 };
  return React.createElement(
    "div",
    null,
    React.createElement(
      "output",
      null,
      JSON.stringify({
        terminalWidth: dimensions.terminalWidth,
        terminalHeight: dimensions.terminalHeight,
      })
    ),
    React.createElement(
      "button",
      { onClick: () => dimensions.resizeTerminal(terminal) },
      "resize terminal"
    ),
    React.createElement(
      "button",
      { onClick: () => dimensions.commitTerminalSize(terminal) },
      "commit terminal"
    )
  );
}

describe("terminal dimension persistence", () => {
  let root: Root;
  let container: HTMLDivElement;
  function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label
    )!;
    act(() => button.click());
  }
  function read() {
    return JSON.parse(container.querySelector("output")!.textContent!);
  }
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("uses terminal defaults independently of obsolete trail preferences", () => {
    localStorage.setItem("orgii:focusedChatWorkstationRailWidth", "500");
    localStorage.setItem("orgii:focusedChatWorkstationRailHeight", "500");
    act(() => root.render(React.createElement(DimensionProbe)));
    expect(read()).toEqual({
      terminalWidth: 400,
      terminalHeight: 260,
    });
  });

  it("updates live dimensions without storage writes, then persists on release", () => {
    act(() => root.render(React.createElement(DimensionProbe)));
    click("resize terminal");
    expect(read()).toEqual({
      terminalWidth: 570,
      terminalHeight: 350,
    });
    expect(getStoredTrailTerminalWidth()).toBeNull();
    expect(getStoredTrailTerminalHeight()).toBeNull();
    click("commit terminal");
    expect(getStoredTrailTerminalWidth()).toBe(570);
    expect(getStoredTrailTerminalHeight()).toBe(350);
    act(() => root.render(null));
    act(() => root.render(React.createElement(DimensionProbe)));
    expect(read()).toMatchObject({
      terminalWidth: 570,
      terminalHeight: 350,
    });
  });

  it("clamps persisted dimensions before they reach the panel layout", () => {
    persistTrailTerminalSize(9999, -20);
    act(() => root.render(React.createElement(DimensionProbe)));
    expect(read()).toMatchObject({
      terminalWidth: 720,
      terminalHeight: 120,
    });
  });

  it("keeps resizing functional if browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    act(() => root.render(React.createElement(DimensionProbe)));
    expect(() => {
      click("resize terminal");
      click("commit terminal");
    }).not.toThrow();
    expect(read()).toMatchObject({ terminalWidth: 570, terminalHeight: 350 });
  });

  it("keeps restored terminal widths large enough for the single-row controls", () => {
    persistTrailTerminalSize(220, 350);
    act(() => root.render(React.createElement(DimensionProbe)));
    expect(read()).toEqual({ terminalWidth: 320, terminalHeight: 350 });
  });
});

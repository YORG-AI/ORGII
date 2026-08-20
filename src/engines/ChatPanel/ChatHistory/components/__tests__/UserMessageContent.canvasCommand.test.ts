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
} from "vitest";

import { EDITOR_FILE_PILL_TEXT_COLOR } from "@src/config/pillTokens";

import UserMessageContent from "../UserMessageContent";

describe("UserMessageContent Canvas command pill", () => {
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

  function renderMessage(text: string) {
    act(() => root.render(createElement(UserMessageContent, { text })));
  }

  it("keeps the Canvas icon after the command is sent", () => {
    renderMessage("canvas [skill:/canvas] 看看这个是啥");

    const canvasIcon = container.querySelector<SVGElement>(
      ".lucide-panels-top-left"
    );
    expect(canvasIcon).not.toBeNull();
    expect(canvasIcon?.style.color).toBe(EDITOR_FILE_PILL_TEXT_COLOR);
    expect(container.querySelector(".lucide-toolbox")).toBeNull();
    expect(container.textContent).toContain("看看这个是啥");
  });

  it("keeps non-Canvas skill messages on the toolbox icon", () => {
    renderMessage("compact [skill:/compact] keep tests");

    expect(container.querySelector(".lucide-toolbox")).not.toBeNull();
    expect(container.querySelector(".lucide-panels-top-left")).toBeNull();
  });
});

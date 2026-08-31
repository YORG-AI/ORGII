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

import UserMessageContent from "../UserMessageContent";

describe("UserMessageContent command references", () => {
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

  it("renders the Canvas command as an ordinary link after it is sent", () => {
    renderMessage("canvas [skill:/canvas] 看看这个是啥");

    expect(container.querySelector("a[href='/canvas']")?.textContent).toBe(
      "canvas"
    );
    expect(container.querySelector('[data-icon="panels-top-left"]')).toBeNull();
    expect(container.querySelector('[data-icon="toolbox"]')).toBeNull();
    expect(container.textContent).toContain("看看这个是啥");
  });

  it("renders other commands without toolbox tags", () => {
    renderMessage("compact [skill:/compact] keep tests");

    expect(container.querySelector("a[href='/compact']")?.textContent).toBe(
      "compact"
    );
    expect(container.querySelector('[data-icon="toolbox"]')).toBeNull();
    expect(container.querySelector('[data-icon="panels-top-left"]')).toBeNull();
  });
});

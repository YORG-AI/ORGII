// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DebugJsonTreeBody } from "./index";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("DebugJsonTreeBody keyboard semantics", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("makes expandable rows keyboard-operable and leaves primitive rows inert", () => {
    act(() =>
      root.render(createElement(DebugJsonTreeBody, { data: { answer: 42 } }))
    );

    const rows = container.querySelectorAll<HTMLElement>(".json-node__row");
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("role")).toBe("button");
    expect(rows[0].getAttribute("tabindex")).toBe("0");
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");
    expect(rows[1].hasAttribute("role")).toBe(false);
    expect(rows[1].hasAttribute("tabindex")).toBe(false);
    expect(rows[1].onclick).toBeNull();

    act(() =>
      rows[0].dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          bubbles: true,
          cancelable: true,
        })
      )
    );

    expect(rows[0].getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".json-node__row")).toHaveLength(1);
  });
});

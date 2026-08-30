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

import Avatar from ".";

describe("Avatar", () => {
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

  it("omits an optional image avatar after the image fails to load", () => {
    act(() => {
      root.render(
        createElement(Avatar, {
          src: "https://example.com/avatar.png",
          hideOnError: true,
        })
      );
    });

    const image = container.querySelector("img");
    expect(image).not.toBeNull();

    act(() => {
      image?.dispatchEvent(new Event("error"));
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.firstElementChild).toBeNull();
  });

  it("omits the optional avatar when no image URL exists", () => {
    act(() => {
      root.render(createElement(Avatar, { hideOnError: true }));
    });

    expect(container.firstElementChild).toBeNull();
  });

  it("centers fallback text over a stable identity gradient", () => {
    act(() => {
      root.render(
        createElement(Avatar, { gradientSeed: "Harry-He", size: 20 }, "H")
      );
    });

    const avatar = container.firstElementChild;
    const label = avatar?.firstElementChild;

    expect(avatar?.className).toContain("bg-gradient-to-br");
    expect(avatar?.className).toContain("text-white");
    expect(label?.className).toContain("absolute inset-0");
    expect(label?.className).toContain("items-center justify-center");
    expect(label?.textContent).toBe("H");
  });
});

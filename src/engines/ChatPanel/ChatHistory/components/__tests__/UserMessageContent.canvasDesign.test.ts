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

describe("UserMessageContent Canvas Design preview", () => {
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

  it("renders the captured preview above the dom-component link", () => {
    const jsonText = JSON.stringify({
      schemaVersion: 1,
      origin: "canvas-design",
      previewHtml: '<div style="font-size:28px">M</div>',
      selection: { kind: "element", label: "Stat" },
    });
    const encoded = btoa(encodeURIComponent(jsonText));
    const text = `Stat [dom-component:paste://canvas-design/event-a/1::${encoded}]\n字体变大一些`;

    act(() => root.render(createElement(UserMessageContent, { text })));

    expect(
      container.querySelector("iframe[title='Canvas selection preview']")
    ).not.toBeNull();
    expect(
      container.querySelector("a[href='paste://canvas-design/event-a/1']")
    ).not.toBeNull();
    expect(container.textContent).toContain("Stat");
    expect(container.textContent).toContain("字体变大一些");
  });
});

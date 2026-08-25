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
} from "vitest";

import { highlightToHtml } from "@src/util/language/prismHtml";

import { loadPrismHtml } from "./prismHtmlLoader";
import {
  clearSyntaxHighlightCache,
  useSyntaxHighlight,
} from "./useSyntaxHighlight";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function HighlightProbe({ code }: { code: string }) {
  const html = useSyntaxHighlight(code, { lang: "javascript" });
  return React.createElement("output", { "data-highlighted-html": html });
}

describe("useSyntaxHighlight cache identity", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    clearSyntaxHighlightCache();
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

  function currentHtml(): string | null {
    return (
      container
        .querySelector("output")
        ?.getAttribute("data-highlighted-html") ?? null
    );
  }

  async function flushHighlight(): Promise<void> {
    await act(async () => {
      await loadPrismHtml();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("verifies the exact source before accepting a same-length hash hit", async () => {
    // Both strings are length 12 and collide under the hook's 32-bit FNV-1a
    // index (`1lzhfd8`). The cache must still treat them as distinct sources.
    const first = "Vv-Q(F%10SDJ";
    const second = "3p/b1IB-*Ejm";
    const firstHtml = highlightToHtml(first, "javascript");
    const secondHtml = highlightToHtml(second, "javascript");
    expect(firstHtml).not.toBeNull();
    expect(secondHtml).not.toBeNull();
    expect(secondHtml).not.toBe(firstHtml);

    act(() => {
      root.render(React.createElement(HighlightProbe, { code: first }));
    });
    await flushHighlight();
    expect(currentHtml()).toBe(firstHtml);

    act(() => {
      root.render(React.createElement(HighlightProbe, { code: second }));
    });

    // A colliding compact key must not expose the previous source's HTML even
    // for the render before the new asynchronous result lands.
    expect(currentHtml()).toBe("");
    await flushHighlight();
    expect(currentHtml()).toBe(secondHtml);
  });
});

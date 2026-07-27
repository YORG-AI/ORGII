import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ChatLoadingBlock from "./ChatLoadingBlock";

describe("ChatLoadingBlock", () => {
  it("renders the shared chat skeleton without visible loading text", () => {
    const markup = renderToStaticMarkup(createElement(ChatLoadingBlock));

    expect(markup).toContain("mx-auto w-full max-w-[900px]");
    expect(markup).toContain("h-8 animate-pulse rounded bg-fill-2");
    expect(markup).toMatch(/^<div[^>]*><\/div>$/);
  });
});

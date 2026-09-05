import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ChatLoadingBlock from "./ChatLoadingBlock";

describe("ChatLoadingBlock", () => {
  it("renders the shared chat skeleton without visible loading text", () => {
    const markup = renderToStaticMarkup(createElement(ChatLoadingBlock));

    expect(markup).toContain("mx-auto w-full max-w-[900px]");
    expect(markup).toContain("rounded bg-fill-2");
    expect(markup).toContain("h-8");
    expect(markup).toContain('data-testid="chat-loading-block"');
    // Static by design: a pulse on a placeholder that resolves in a few
    // hundred milliseconds reads as a flash, not as progress.
    expect(markup).not.toContain("animate-pulse");
    expect(markup).toMatch(/^<span[^>]*><\/span>$/);
  });
});

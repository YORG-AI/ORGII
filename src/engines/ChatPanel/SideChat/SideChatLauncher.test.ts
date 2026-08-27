import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SideChatLauncher } from ".";

describe("SideChatLauncher", () => {
  it("renders an accessible floating dialog trigger", () => {
    const markup = renderToStaticMarkup(
      createElement(SideChatLauncher, {
        label: "Side Chat",
        onOpen: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="side-chat-floating-button"');
    expect(markup).toContain('aria-label="Side Chat"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("bottom-4");
    expect(markup).toContain("right-4");
  });
});

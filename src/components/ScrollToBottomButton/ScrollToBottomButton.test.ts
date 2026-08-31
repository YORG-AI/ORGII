// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ScrollToBottomButton from ".";

describe("ScrollToBottomButton", () => {
  it("keeps the desktop ChatPanel treatment and accessible label", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(ScrollToBottomButton, {
        label: "Scroll to bottom",
        onClick: vi.fn(),
      })
    );

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Scroll to bottom");
    expect(button?.getAttribute("title")).toBe("Scroll to bottom");
    expect(button?.classList.contains("!bg-bg-2")).toBe(true);
    expect(container.querySelector('[data-icon="arrow-down"]')).not.toBeNull();
  });
});

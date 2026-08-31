import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

function setUserAgent(userAgent: string) {
  vi.stubGlobal("navigator", { userAgent });
}

describe("KeyboardShortcut", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("renders Ctrl as text on Linux", async () => {
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64)");
    const { KeyboardShortcut } = await import("./index");

    const markup = renderToStaticMarkup(
      createElement(KeyboardShortcut, { shortcut: "Ctrl+Enter" })
    );

    expect(markup).toContain("Ctrl");
  });
});

describe("KeyboardShortcutTooltipContent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("lets long labels wrap while shortcut keys stay in the shared row", async () => {
    const { KeyboardShortcutTooltipContent } = await import("./index");
    const markup = renderToStaticMarkup(
      createElement(KeyboardShortcutTooltipContent, {
        label:
          "A translated tooltip label that can become wider than the viewport",
        shortcut: "Cmd+Enter",
      })
    );

    expect(markup).toContain("min-w-0 max-w-full");
    expect(markup).toContain("min-w-0 break-words");
    expect(markup).not.toContain("whitespace-nowrap");
  });
});

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

  it("renders every key in a chord inside one rounded pill", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    const { KeyboardShortcut } = await import("./index");

    const markup = renderToStaticMarkup(
      createElement(KeyboardShortcut, {
        shortcut: "Cmd+2",
        className: "external-spacing",
      })
    );

    expect(markup.match(/<kbd/g)).toHaveLength(1);
    expect(markup).toContain(
      '<div class="flex items-center external-spacing"><kbd'
    );
    expect(markup).toContain("rounded-full");
    expect(markup).toContain('data-icon="command"');
    expect(markup).toContain(">2</span>");
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

    expect(markup).toContain("max-w-full min-w-0");
    expect(markup).toContain("min-w-0 wrap-break-word");
    expect(markup).not.toContain("whitespace-nowrap");
  });
});

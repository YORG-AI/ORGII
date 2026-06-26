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

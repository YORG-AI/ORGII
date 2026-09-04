import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MobileShell } from "./MobileShell";

describe("MobileShell", () => {
  it("owns the viewport so long transcripts scroll without displacing the composer", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        MobileShell,
        null,
        React.createElement("div", null, "chat")
      )
    );

    expect(markup).toContain("h-full justify-center overflow-hidden");
    expect(markup).toContain("pt-[env(safe-area-inset-top)]");
    expect(markup).toContain("h-full min-h-0");
  });
});

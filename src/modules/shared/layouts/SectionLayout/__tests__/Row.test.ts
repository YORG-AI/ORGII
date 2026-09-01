import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SectionRow from "../Row";

describe("SectionRow", () => {
  it("keeps inline label/value rows side-by-side below the responsive breakpoint", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        SectionRow,
        { label: "Desktop", layout: "inline" },
        React.createElement("span", null, "Home Mac")
      )
    );

    expect(html).toContain("flex-row justify-between gap-4");
    expect(html).not.toContain("@[480px]:flex-row");
    expect(html).toContain("Desktop");
    expect(html).toContain("Home Mac");
  });

  it("preserves the responsive horizontal layout by default", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        SectionRow,
        { label: "Theme" },
        React.createElement("span", null, "System")
      )
    );

    expect(html).toContain("flex-col");
    expect(html).toContain("@[480px]:flex-row");
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CircleIcon } from "@src/icons";

import SectionHeading from "../Heading";
import { SECTION_INTRO_TOKENS } from "../tokens";

describe("SectionHeading", () => {
  it("preserves the existing section heading contract by default", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        SectionHeading,
        { title: "General" },
        React.createElement("div", null, "Settings")
      )
    );

    expect(html).toContain("<h2");
    expect(html).toContain("sticky top-0");
    expect(html).toContain("General");
    expect(html).toContain("Settings");
  });

  it("owns the semantic intro hierarchy for content surfaces", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        SectionHeading,
        {
          appearance: "intro",
          headingLevel: 1,
          title: "Choose a tutorial",
          description: "Learn on the product surface.",
          icon: CircleIcon,
        },
        React.createElement("div", null, "Tutorial choices")
      )
    );

    expect(html).toContain("<section");
    expect(html).toContain('aria-labelledby="');
    expect(html).toContain("<h1");
    expect(html).toContain(SECTION_INTRO_TOKENS.title);
    expect(html).toContain("Learn on the product surface.");
    expect(html).toContain("Tutorial choices");
  });
});

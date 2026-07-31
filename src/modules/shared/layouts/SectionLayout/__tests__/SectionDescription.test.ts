import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SectionDescription from "../Description";
import { SECTION_DESCRIPTION_CLASSES } from "../tokens";

describe("SectionDescription", () => {
  it("owns semantic paragraph markup and the shared description token", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        SectionDescription,
        { role: "note", className: "extra-copy" },
        "Supporting copy"
      )
    );

    expect(html).toContain("<p");
    expect(html).toContain('role="note"');
    expect(html).toContain(SECTION_DESCRIPTION_CLASSES);
    expect(html).toContain("extra-copy");
    expect(html).toContain("Supporting copy");
  });
});

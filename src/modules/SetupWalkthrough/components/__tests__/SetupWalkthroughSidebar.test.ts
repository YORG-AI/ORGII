import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SetupWalkthroughSidebar from "../SetupWalkthroughSidebar";

describe("SetupWalkthroughSidebar", () => {
  it("renders the cinematic brand hero without wizard progress", () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupWalkthroughSidebar, {
        title: React.createElement(
          React.Fragment,
          null,
          "Let's set up your ",
          React.createElement("span", null, "ORGII")
        ),
        description: "A few quick choices to personalize your workspace.",
      })
    );

    expect(html).toContain("Let&#x27;s set up your");
    expect(html).toContain("personalize your workspace");
    expect(html).toContain("logo.png");
    expect(html).toContain("org2-pearl-relay-mascot.png");
    expect(html).toContain('aria-labelledby="setup-hero-title"');
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('aria-label="Setup steps"');
  });
});

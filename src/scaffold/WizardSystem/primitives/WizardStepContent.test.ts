import { Circle } from "lucide-react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HEADER_ICON_SIZE, TYPOGRAPHY } from "@src/config/workstation/tokens";

import WizardStepContent, {
  WIZARD_STEP_CONTENT_TOKENS,
} from "./WizardStepContent";

describe("WizardStepContent", () => {
  it("owns the shared wizard heading hierarchy and accessible relationship", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        WizardStepContent,
        {
          title: "Choose a tutorial",
          description: "Learn on the product surface.",
          icon: Circle,
        },
        React.createElement("div", null, "Step controls")
      )
    );

    expect(html).toContain("<section");
    expect(html).toContain('aria-labelledby="');
    expect(html).toContain("<h1");
    expect(html).toContain("Choose a tutorial");
    expect(html).toContain("Learn on the product surface.");
    expect(WIZARD_STEP_CONTENT_TOKENS.iconSize).toBe(HEADER_ICON_SIZE.md);
    expect(WIZARD_STEP_CONTENT_TOKENS.title).toContain(TYPOGRAPHY.contentTitle);
    expect(WIZARD_STEP_CONTENT_TOKENS.description).toContain(
      TYPOGRAPHY.contentSubtitle
    );
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CircleIcon } from "@src/icons";
import { SECTION_INTRO_TOKENS } from "@src/modules/shared/layouts/SectionLayout";

import WizardStepContent, {
  WIZARD_STEP_CONTENT_TOKENS,
} from "../WizardStepContent";

describe("WizardStepContent", () => {
  it("owns the shared wizard heading hierarchy and accessible relationship", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        WizardStepContent,
        {
          title: "Choose a tutorial",
          description: "Learn on the product surface.",
          icon: CircleIcon,
        },
        React.createElement("div", null, "Step controls")
      )
    );

    expect(html).toContain("<section");
    expect(html).toContain('aria-labelledby="');
    expect(html).toContain("<h1");
    expect(html).toContain("Choose a tutorial");
    expect(html).toContain("Learn on the product surface.");
    expect(html).toContain(SECTION_INTRO_TOKENS.title);
    expect(html).toContain(SECTION_INTRO_TOKENS.description);
    expect(WIZARD_STEP_CONTENT_TOKENS.container).toContain("max-w-[900px]");
  });
});

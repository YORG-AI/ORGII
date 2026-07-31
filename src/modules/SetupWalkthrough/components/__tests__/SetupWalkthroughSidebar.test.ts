import { Circle } from "lucide-react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SetupWalkthroughSidebar from "../SetupWalkthroughSidebar";

describe("SetupWalkthroughSidebar", () => {
  it("renders the compact first-run treatment without wizard progress", () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupWalkthroughSidebar, {
        brandTag: "Setup",
        description: "Choose language and appearance.",
      })
    );

    expect(html).toContain("Choose language and appearance.");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('aria-label="Setup steps"');
  });

  it("composes the shared logo, progress, and wizard navigation contracts", () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupWalkthroughSidebar, {
        brandTag: "Setup",
        description: "Progress is saved after every step.",
        progressLabel: "Step 1 of 2",
        progressPercent: 50,
        navigationLabel: "Setup steps",
        activeStepId: "goal",
        onSelectStep: () => undefined,
        navigationItems: [
          {
            id: "goal",
            title: "Goal",
            description: "Choose an outcome",
            icon: Circle,
            completed: false,
          },
          {
            id: "tools",
            title: "Tools",
            description: "Detect local access",
            icon: Circle,
            completed: false,
            disabled: true,
          },
        ],
      })
    );

    expect(html).toContain("<aside");
    expect(html).toContain("logo.png");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('aria-label="Setup steps"');
    expect(html).toContain('data-testid="setup-step-goal"');
    expect(html).toContain('data-testid="setup-step-tools"');
  });
});

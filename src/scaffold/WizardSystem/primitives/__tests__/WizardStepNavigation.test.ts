import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WizardStepNavigation from "../WizardStepNavigation";

const TestIcon: React.FC<{ size?: number | string }> = ({ size = 16 }) =>
  React.createElement("span", {
    "data-testid": "repository-test-icon",
    style: { width: size, height: size },
  });

describe("WizardStepNavigation", () => {
  it("renders active, completed, and locked steps with accessible state", () => {
    const html = renderToStaticMarkup(
      React.createElement(WizardStepNavigation, {
        activeId: "tools",
        ariaLabel: "Setup steps",
        onSelect: () => undefined,
        testIdPrefix: "setup-step",
        items: [
          {
            id: "goal",
            title: "Goal",
            description: "Choose an outcome",
            icon: TestIcon,
            completed: true,
          },
          {
            id: "tools",
            title: "Tools",
            description: "Detect local access",
            icon: TestIcon,
            completed: false,
          },
          {
            id: "ready",
            title: "Ready",
            description: "Open the destination",
            icon: TestIcon,
            completed: false,
            disabled: true,
          },
        ],
      })
    );

    expect(html).toContain("<nav");
    expect(html).toContain('aria-label="Setup steps"');
    expect(html).toContain('data-testid="setup-step-goal"');
    expect(html).toContain('data-testid="setup-step-tools"');
    expect(html).toContain('aria-current="step"');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*data-testid="setup-step-ready"/
    );
    expect(html).toContain("Goal");
    expect(html).toContain("Ready");
  });

  it("disables every step while the owning flow is busy", () => {
    const html = renderToStaticMarkup(
      React.createElement(WizardStepNavigation, {
        activeId: "goal",
        ariaLabel: "Setup steps",
        disabled: true,
        onSelect: () => undefined,
        items: [
          {
            id: "goal",
            title: "Goal",
            description: "Choose an outcome",
            icon: TestIcon,
            completed: false,
          },
          {
            id: "tools",
            title: "Tools",
            description: "Detect local access",
            icon: TestIcon,
            completed: false,
          },
        ],
      })
    );

    expect(html.match(/ disabled=""/g)).toHaveLength(2);
  });
});

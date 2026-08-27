import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SessionSetupStepIndicator from "./SessionSetupStepIndicator";

function renderIndicator({
  step,
  currentStep,
  completed = false,
}: {
  step: number;
  currentStep: number;
  completed?: boolean;
}): string {
  return renderToStaticMarkup(
    React.createElement(SessionSetupStepIndicator, {
      step,
      currentStep,
      completed,
      label: `Step ${step}`,
    })
  );
}

describe("SessionSetupStepIndicator", () => {
  it("renders the active step with the primary treatment", () => {
    const markup = renderIndicator({ step: 1, currentStep: 1 });

    expect(markup).toContain("bg-primary-6 text-text-white");
    expect(markup).toContain("font-medium text-text-1");
    expect(markup).toContain(">1</div>");
    expect(markup).toContain("Step 1");
  });

  it("renders completed steps with the success checkmark treatment", () => {
    const markup = renderIndicator({
      step: 2,
      currentStep: 1,
      completed: true,
    });

    expect(markup).toContain("bg-success-6 text-text-white");
    expect(markup).toContain('<span class="text-[10px]">✓</span>');
    expect(markup).toContain("font-normal text-text-3");
  });

  it("renders future steps with the neutral treatment", () => {
    const markup = renderIndicator({ step: 2, currentStep: 1 });

    expect(markup).toContain("border border-border-2 bg-bg-2 text-text-3");
    expect(markup).toContain("font-normal text-text-3");
    expect(markup).toContain(">2</div>");
  });
});

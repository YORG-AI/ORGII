// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import i18n from "@src/i18n";

import { SETUP_WALKTHROUGH_PRESENTATION } from "../../presentation";
import SetupWalkthroughSidebar from "../SetupWalkthroughSidebar";

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

describe("SetupWalkthroughSidebar", () => {
  const sharedProps = {
    title: React.createElement(
      React.Fragment,
      null,
      "Let's set up your ",
      React.createElement("span", null, "ORGII")
    ),
    description: "A few quick choices to personalize your workspace.",
  };

  it("renders the compact app preview without wizard progress", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(SetupWalkthroughSidebar, {
          ...sharedProps,
          presentation: SETUP_WALKTHROUGH_PRESENTATION.COMPACT,
        })
      )
    );

    expect(html).toContain("Let&#x27;s set up your");
    expect(html).toContain("personalize your workspace");
    expect(html).toContain("logo.png");
    expect(html).toContain('data-testid="setup-compact-preview"');
    expect(html).toContain('data-testid="setup-application-preview"');
    expect(html).toContain('data-testid="setup-preview-composer"');
    expect(html).toContain('data-testid="setup-preview-submit"');
    expect(html).toContain('data-testid="setup-preview-tab-sde"');
    expect(html).toContain('data-testid="setup-preview-tab-team-inbox"');
    expect(html).toContain('data-testid="setup-preview-tab-work-items"');
    expect(html).toContain('data-testid="setup-preview-panel-sde"');
    expect(html).toContain('data-testid="setup-preview-files-toggle"');
    expect(html).toContain("SDE Agent");
    expect(html).not.toContain('data-testid="setup-preview-code-panel"');
    expect(html).not.toContain('data-testid="setup-preview-code-editor"');
    expect(html).not.toContain("package.json");
    expect(html).not.toContain("org2-pearl-relay-mascot.png");
    expect(html).toContain('aria-labelledby="setup-hero-title"');
    expect(html).not.toContain('role="progressbar"');
  });

  it("replaces only the preview visual with the mascot variant", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(SetupWalkthroughSidebar, {
          ...sharedProps,
          presentation: SETUP_WALKTHROUGH_PRESENTATION.MASCOT,
        })
      )
    );

    expect(html).toContain('data-testid="setup-mascot-preview"');
    expect(html).toContain("org2-pearl-relay-mascot.png");
    expect(html).not.toContain('data-testid="setup-application-preview"');
    expect(html).not.toContain('data-testid="setup-compact-preview"');
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ActionCard from ".";

describe("ActionCard accessibility contract", () => {
  it("renders a selectable card as a native pressed button", () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionCard, {
        title: "Managed cloud",
        onClick: vi.fn(),
        showSelect: true,
        selected: true,
        dataTestId: "cloud-source",
      })
    );

    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-testid="cloud-source"');
    expect(html).toContain("border-primary-6 bg-primary-1");
  });

  it("keeps cards with a trailing action free of nested buttons", () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionCard, {
        title: "Connected account",
        onClick: vi.fn(),
        buttonText: "Manage",
      })
    );

    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/^<div/);
  });

  it("separates stacked card metadata from the title row", () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionCard, {
        title: "See team activity",
        description: "Connect an organization and choose repo visibility.",
        badge: "Recommended",
        layout: "stacked",
        onClick: vi.fn(),
        showSelect: true,
        selected: true,
      })
    );

    expect(html).toContain('data-action-card-layout="stacked"');
    expect(html).toContain("Recommended");
    expect(html).toContain("See team activity");
    expect(html).toContain('aria-pressed="true"');
  });

  it("can express selection without inserting a trailing check", () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionCard, {
        title: "See team activity",
        badge: "Recommended",
        layout: "stacked",
        onClick: vi.fn(),
        showSelect: true,
        showSelectionCheck: false,
        selected: true,
      })
    );

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Recommended");
    expect(html).not.toContain("<svg");
  });

  it("renders compact inline cards at the 36px segmented-control height", () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionCard, {
        title: "Auto-detect",
        onClick: vi.fn(),
        compact: true,
      })
    );

    expect(html).toContain("h-9 px-2 py-0");
    expect(html).toContain("flex items-center gap-2 h-full");
  });
});

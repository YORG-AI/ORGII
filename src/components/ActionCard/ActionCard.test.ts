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
});

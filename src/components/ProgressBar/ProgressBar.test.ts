import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ProgressBar from ".";

describe("ProgressBar accessibility contract", () => {
  it("exposes bounded progress semantics when it has an accessible label", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProgressBar, {
        percent: 125,
        ariaLabel: "Step 4 of 8",
      })
    );

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Step 4 of 8"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="100"');
  });

  it("does not create an unnamed progressbar when no label is provided", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProgressBar, { percent: 40 })
    );

    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("aria-valuenow");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CanvasErrorBoundary } from "./CanvasErrorBoundary";

describe("CanvasErrorBoundary", () => {
  it("renders Canvas failures as a shared danger InlineAlert", () => {
    const boundary = new CanvasErrorBoundary({
      children: createElement("div", null, "Canvas content"),
    });
    boundary.state = { error: new Error("Canvas render crashed") };

    const markup = renderToStaticMarkup(boundary.render());

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-icon="triangle-alert"');
    expect(markup).toContain("shadow-dropdown-soft");
    expect(markup).toContain("Preview failed");
    expect(markup).toContain("Canvas render crashed");
  });
});

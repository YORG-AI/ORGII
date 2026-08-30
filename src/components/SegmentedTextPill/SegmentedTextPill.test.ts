import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SegmentedTextPill from ".";

const options = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

function renderPill(size?: "small" | "default"): string {
  return renderToStaticMarkup(
    createElement(SegmentedTextPill, {
      ariaLabel: "Position",
      onChange: () => undefined,
      options,
      size,
      value: "left",
    })
  );
}

describe("SegmentedTextPill", () => {
  it("preserves the established dimensions by default", () => {
    const markup = renderPill();

    expect(markup).toContain("h-[28px]");
    expect(markup).toContain("h-6 px-2.5");
  });

  it("offers a smaller variant for compact setting rows", () => {
    const markup = renderPill("small");

    expect(markup).toContain("h-6 text-[11px]");
    expect(markup).toContain("h-5 px-2");
    expect(markup).toContain('aria-label="Position"');
  });
});
